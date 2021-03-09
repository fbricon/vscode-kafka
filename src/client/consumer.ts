import { Kafka, Consumer as KafkaJsConsumer, PartitionAssigner, Assignment, PartitionAssigners, AssignerProtocol, SeekEntry } from "kafkajs";
import { URLSearchParams } from "url";
import * as vscode from "vscode";
import { getWorkspaceSettings, InitialConsumerOffset, ClusterSettings } from "../settings";
import { ConnectionOptions, createKafka } from "./client";

interface ConsumerOptions extends ConnectionOptions {
    consumerGroupId: string;
    topicId: string;
    fromOffset: InitialConsumerOffset | string;
    partitions?: number[];
}

export interface RecordReceivedEvent {
    uri: vscode.Uri;
    record: ConsumedRecord;
}

export interface ConsumedRecord {
    topic: string;
    value: string | Buffer | null;
    offset?: string;
    partition?: number;
    key?: string | Buffer;
}

export interface ConsumerChangedStatusEvent {
    uri: vscode.Uri;
    status: "created" | "rebalancing" | "rebalanced";
}

export enum ConsumerLaunchState {
    none,
    starting,
    started,
    closing,
    closed
}

export interface ConsumerCollectionChangedEvent {
    consumers: Consumer[];
}

export class Consumer implements vscode.Disposable {
    private kafkaClient?: Kafka;
    private consumer?: KafkaJsConsumer;
    private onDidReceiveMessageEmitter = new vscode.EventEmitter<RecordReceivedEvent>();
    private onDidReceiveErrorEmitter = new vscode.EventEmitter<any>();
    private onDidChangeStatusEmitter = new vscode.EventEmitter<ConsumerChangedStatusEvent>();

    public onDidReceiveRecord = this.onDidReceiveMessageEmitter.event;
    public onDidReceiveError = this.onDidReceiveErrorEmitter.event;
    public onDidChangeStatus = this.onDidChangeStatusEmitter.event;

    public readonly clusterId: string;
    public readonly options: ConsumerOptions;
    public state: ConsumerLaunchState = ConsumerLaunchState.none;
    public error: any;

    constructor(public uri: vscode.Uri, clusterSettings: ClusterSettings) {
        const { clusterId, consumerGroupId, topicId, fromOffset, partitions } = extractConsumerInfoUri(uri);
        this.clusterId = clusterId;
        const cluster = clusterSettings.get(clusterId);

        try {
            if (!cluster) {
                throw new Error(`Cannot create consumer, unknown cluster ${clusterId}`);
            }

            const settings = getWorkspaceSettings();
            this.options = {
                bootstrap: cluster.bootstrap,
                saslOption: cluster.saslOption,
                consumerGroupId: consumerGroupId,
                topicId,
                fromOffset: fromOffset || settings.consumerOffset,
                partitions: parsePartitions(partitions),
                connectionProviderId: cluster.connectionProviderId
            };
        }
        catch (e) {
            this.error = e;
            throw e;
        }
    }

    /***
     * Starts a new consumer group that subscribes to the provided topic.
     * Received messages and/or errors are emitted via events.
     */
    async start(): Promise<void> {
        const partitions = this.options.partitions;
        const partitionAssigner = this.getPartitionAssigner(partitions);
        const fromOffset = this.options.fromOffset;
        const topic = this.options.topicId;

        this.kafkaClient = createKafka(this.options);
        this.consumer = this.kafkaClient.consumer({
            groupId: this.options.consumerGroupId, retry: { retries: 3 },
            partitionAssigners: [
                partitionAssigner
            ]
        });
        await this.consumer.connect();

        const subscribeOptions = this.createSubscribeOptions(topic, fromOffset);
        await this.consumer.subscribe(subscribeOptions);

        this.consumer.run({
            eachMessage: async ({ topic, partition, message }) => {
                this.onDidReceiveMessageEmitter.fire({
                    uri: this.uri,
                    record: { topic: topic, partition: partition, ...message },
                });
            },
        });

        const offsetAsNumber = (fromOffset && subscribeOptions.fromBeginning === undefined);
        if (partitions || offsetAsNumber) {
            const definedOffset = offsetAsNumber ? fromOffset : undefined;
            const topicOffsets = !definedOffset ? await this.kafkaClient?.admin().fetchTopicOffsets(topic) : undefined;
            const definedPartitions = await this.getPartitions(topic, partitions);
            for (let i = 0; i < definedPartitions.length; i++) {
                const partition = definedPartitions[i];
                const offset = definedOffset || await this.getOffsetToSeek(topicOffsets, fromOffset, partition);
                this.consumer.seek({ topic, partition, offset });
            }
        }
    }

    private async getPartitions(topic: string, partitions?: number[]): Promise<number[]> {
        if (partitions) {
            // returns the customized partitions
            return partitions;
        }
        // returns the topics partitions
        const partitionMetadata = await this.kafkaClient?.admin().fetchTopicMetadata({ topics: [topic] });
        return partitionMetadata?.topics[0].partitions.map(m => m.partitionId) || [0];
    }

    private async getOffsetToSeek(topicOffsets: Array<SeekEntry & { high: string; low: string }> | undefined, fromOffset: string, partition: number): Promise<string> {
        const result = topicOffsets?.find(p => p.partition === partition);
        if (!result) {
            return '0';
        }
        if (fromOffset === "latest") {
            return result.high;
        }
        return result.low;
    }

    private getPartitionAssigner(partitions?: number[]): PartitionAssigner {
        if (!partitions) {
            return PartitionAssigners.roundRobin;
        }
        const userData = Buffer.alloc(0);
        return ({ cluster }) => ({
            name: 'AssignedPartitionsAssigner',
            version: 1,
            async assign({ members, topics }) {
                const sortedMembers = members.map(({ memberId }) => memberId).sort();
                const firstMember = sortedMembers[0];
                const assignment = {
                    [firstMember]: {} as Assignment,
                };

                topics.forEach(topic => {
                    assignment[firstMember][topic] = partitions;
                });

                return Object.keys(assignment).map(memberId => ({
                    memberId,
                    memberAssignment: AssignerProtocol.MemberAssignment.encode({
                        version: this.version,
                        assignment: assignment[memberId],
                        userData,
                    }),
                }));
            },
            protocol({ topics }) {
                return {
                    name: this.name,
                    metadata: AssignerProtocol.MemberMetadata.encode({
                        version: this.version,
                        topics,
                        userData,
                    })
                };
            }
        });
    }

    private createSubscribeOptions(topic: string, fromOffset?: string): { topic: string, fromBeginning?: boolean } {
        if (fromOffset === "earliest" || fromOffset === "latest") {
            const fromBeginning = fromOffset === "earliest";
            return { topic, fromBeginning };
        }
        return { topic };
    }

    dispose(): void {
        if (this.consumer) {
            this.consumer.disconnect();
        }

        this.onDidReceiveErrorEmitter.dispose();
        this.onDidReceiveMessageEmitter.dispose();
    }
}

/**
 * A collection of consumers.
 */
export class ConsumerCollection implements vscode.Disposable {
    private consumers: { [id: string]: Consumer } = {};
    private disposables: vscode.Disposable[] = [];

    private onDidChangeCollectionEmitter = new vscode.EventEmitter<ConsumerCollectionChangedEvent>();
    public onDidChangeCollection = this.onDidChangeCollectionEmitter.event;

    constructor(private clusterSettings: ClusterSettings) {
    }

    /**
     * Creates a new consumer for a provided uri.
     */
    async create(uri: vscode.Uri): Promise<Consumer> {
        // Create the consumer
        const consumer = new Consumer(uri, this.clusterSettings);
        this.consumers[uri.toString()] = consumer;

        // Fire an event to notify that Consumer is starting
        consumer.state = ConsumerLaunchState.starting;
        this.onDidChangeCollectionEmitter.fire({
            consumers: [consumer]
        });

        // Start the consumer
        await consumer.start()
            .then(() => consumer.state = ConsumerLaunchState.started)
            .catch(e => {
                delete this.consumers[uri.toString()];
                consumer.state = ConsumerLaunchState.none;
                consumer.error = e;
                throw e;
            })
            .finally(() => {
                // Fire an event to notify that consumer state changed
                // with a delay because when start is done quickly
                // the trace 'Consumer: started' is not displayed.
                setTimeout(() => {
                    this.onDidChangeCollectionEmitter.fire({
                        consumers: [consumer]
                    });
                }, 200);
            });

        return consumer;
    }

    /**
     * Retrieve the number of active consumers
     */
    length(): number {
        return Object.keys(this.consumers).length;
    }

    /**
     * Retrieve an existing consumer if exists.
     */
    get(uri: vscode.Uri): Consumer | null {
        if (!this.has(uri)) {
            return null;
        }

        return this.consumers[uri.toString()];
    }

    /**
     * Retrieve all consumers
     */
    getAll(): Consumer[] {
        return Object.keys(this.consumers).map((c) => this.consumers[c]);
    }

    /**
     * Return the consumer of the given cluster associated with the consumer group id.
     *
     * @param clusterId
     * @param consumerGroupId
     */
    getByConsumerGroupId(clusterId: string, consumerGroupId: string): Consumer | undefined {
        return this.getAll()
            .find(c => clusterId === c.clusterId && c.options.consumerGroupId === consumerGroupId);
    }

    /**
     * Closes an existing consumer if exists.
     */
    async close(uri: vscode.Uri): Promise<void> {
        const consumer = this.get(uri);

        if (consumer === null) {
            return;
        }

        // Fire an event to notify that consumer is closing
        consumer.state = ConsumerLaunchState.closing;
        this.onDidChangeCollectionEmitter.fire({
            consumers: [consumer]
        });

        consumer.dispose();
        delete this.consumers[uri.toString()];

        // Fire an event to notify that consumer is closed
        consumer.state = ConsumerLaunchState.closed;
        this.onDidChangeCollectionEmitter.fire({
            consumers: [consumer]
        });
    }

    /**
     * Check whether a consumer exists.
     */
    has(uri: vscode.Uri): boolean {
        return this.consumers.hasOwnProperty(uri.toString());
    }

    dispose(): void {
        this.disposeConsumers();
        this.disposables.forEach((d) => d.dispose());
        this.onDidChangeCollectionEmitter.dispose();
    }

    disposeConsumers(): void {
        Object.keys(this.consumers).forEach((key) => {
            this.consumers[key].dispose();
        });

        this.consumers = {};
    }
}

// ---------- Consumer URI utilities

export interface ConsumerInfoUri {
    clusterId: string;
    consumerGroupId: string;
    topicId: InitialConsumerOffset | string;
    fromOffset?: string;
    partitions?: string;
}

const TOPIC_QUERY_PARAMETER = 'topic';
const FROM_QUERY_PARAMETER = 'from';
const PARTITIONS_QUERY_PARAMETER = 'partitions';

export function createConsumerUri(info: ConsumerInfoUri): vscode.Uri {
    const path = `kafka:${info.clusterId}/${info.consumerGroupId}`;
    let query = '';
    query = addQueryParameter(query, TOPIC_QUERY_PARAMETER, info.topicId);
    query = addQueryParameter(query, FROM_QUERY_PARAMETER, info.fromOffset);
    query = addQueryParameter(query, PARTITIONS_QUERY_PARAMETER, info.partitions);
    return vscode.Uri.parse(path + query);
}

function addQueryParameter(query: string, name: string, value?: string): string {
    if (value === undefined) {
        return query;
    }
    return `${query}${query.length > 0 ? '&' : '?'}${name}=${value}`;
}

export function extractConsumerInfoUri(uri: vscode.Uri): ConsumerInfoUri {
    const [clusterId, consumerGroupId] = uri.path.split("/");
    const urlParams = new URLSearchParams(uri.query);
    const topicId = urlParams.get(TOPIC_QUERY_PARAMETER) || '';
    const from = urlParams.get(FROM_QUERY_PARAMETER);
    const partitions = urlParams.get(PARTITIONS_QUERY_PARAMETER);
    return {
        clusterId,
        consumerGroupId,
        topicId,
        fromOffset: from && from.trim().length > 0 ? from : undefined,
        partitions: partitions && partitions.trim().length > 0 ? partitions : undefined
    };
}

export function parsePartitions(partitions?: string): number[] | undefined {
    partitions = partitions?.trim();
    if (partitions && partitions.length > 0) {
        let from: string | undefined = undefined;
        let to: string | undefined = undefined;
        const result = new Set<number>();
        const add = function (from: string | undefined, to: string | undefined) {
            if (!from) {
                return;
            }
            const fromAsNumber = parseInt(from, 10);
            const toAsNumber = to ? parseInt(to, 10) : fromAsNumber;
            for (let i = fromAsNumber; i <= toAsNumber; i++) {
                result.add(i);
            }
        };
        for (let i = 0; i < partitions.length; i++) {
            const c = partitions.charAt(i);
            if (c === ' ') {
                continue;
            } else if (c === ',') {
                add(from, to);
                from = undefined;
                to = undefined;
            } else if (c === '-') {
                to = '';
            } else if (!isNaN(parseInt(c, 10))) {
                if (to !== undefined) {
                    to += c;
                } else {
                    from = from || '';
                    from += c;
                }
            } else {
                throw new Error(`Unexpected character '${c}' in partitions expression.`);
            }
        }
        add(from, to);
        // returns sorted and distinct partitions
        return result.size > 0 ? Array.from(result).sort() : undefined;
    }
    return undefined;
}
