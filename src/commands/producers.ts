import * as vscode from "vscode";

import { performance } from "perf_hooks";
import { ClientAccessor } from "../client";
import { OutputChannelProvider } from "../providers/outputChannelProvider";

export class ProduceRecordCommandHandler {
    constructor(
        private clientAccessor: ClientAccessor, 
        private channelProvider: OutputChannelProvider) {
    }

    async execute(document: vscode.TextDocument, range: vscode.Range, times: number): Promise<void> {
        const channel = this.channelProvider.getChannel("Kafka Producer Log");
        const { topic, key, value } = this.parseDocumentRange(document, range);
        const messages = [...Array(times).keys()].map(() => value);

        if (topic === undefined) {
            channel.appendLine("No topic");
            return;
        }

        const client = this.clientAccessor.getSelectedClusterClient();

        if (!client) {
            vscode.window.showWarningMessage("No cluster selected");
            return;
        }

        const producer = key !== undefined ?
            client.kafkaKeyedProducerClient : client.kafkaCyclicProducerClient;

        channel.show(false);
        channel.appendLine(`Producing record(s)`);
        const startOperation = performance.now();

        producer.send([{
            topic,
            attributes: 0,
            key,
            messages,
        }], (error: any, result: any) => {
            const finishedOperation = performance.now();
            const elapsed = (finishedOperation - startOperation).toFixed(2);

            if (error) {
                channel.appendLine(`Failed to produce record(s) (${elapsed}ms)`);

                if (error.message) {
                    channel.appendLine(`Error: ${error.message}`);
                } else {
                    channel.appendLine(`Error: ${error}`);
                }

                return;
            }

            channel.appendLine(`Produced ${times} record(s) (${elapsed}ms)`);
        });
    }

    private parseDocumentRange(document: vscode.TextDocument, range: vscode.Range): { topic?: string; key?: string; value: string } {
        let topic;
        let key;
        let value = "";
        for (let currentLine = range.start.line + 1; currentLine <= range.end.line; currentLine++) {
            const line = document.lineAt(currentLine);

            if (line.text.startsWith("topic:")) {
                topic = line.text.substr("topic:".length).trim();
                continue;
            }

            if (line.text.startsWith("key:")) {
                key = line.text.substr("key:".length).trim();
                continue;
            }

            if (line.text.startsWith("--")) {
                continue;
            }

            value = document.getText(new vscode.Range(currentLine, 0, range.end.line + 1, 0)).trim();
            break;
        }

        return {
            topic,
            key,
            value,
        };
    }
}
