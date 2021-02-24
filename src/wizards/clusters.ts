import { authentication, QuickPickItem, window } from "vscode";
import axios from 'axios';
import { ConnectionOptions, SaslMechanism } from "../client";
import { INPUT_TITLE } from "../constants";
import { KafkaExplorer } from "../explorer/kafkaExplorer";
import { ClusterSettings } from "../settings/clusters";
import { MultiStepInput, showErrorMessage, State } from "./multiStepInput";
import { validateBroker, validateClusterName, validateAuthentificationUserName } from "./validators";

const DEFAULT_BROKER = 'localhost:9092';

interface AddClusterState extends State, ConnectionOptions {
    name: string;
}

const DEFAULT_STEPS = 4;

export async function addClusterWizard(clusterSettings: ClusterSettings, explorer: KafkaExplorer): Promise<void> {

    const state: Partial<AddClusterState> = {
        totalSteps: DEFAULT_STEPS
    };

    // async function collectInputs(state: Partial<AddClusterState>, clusterSettings: ClusterSettings) {
    //     await MultiStepInput.run(input => inputBrokers(input, state, clusterSettings));
    // }

    async function collectInputs(state: Partial<AddClusterState>, clusterSettings: ClusterSettings) {
        await MultiStepInput.run(input => inputClusterType(input, state, clusterSettings));
    }

    async function inputClusterType(input: MultiStepInput, state: Partial<AddClusterState>, clusterSettings: ClusterSettings) {
        const types = [{ label: 'Manual' }, { label: 'Red Hat' }];

        const type = (await input.showQuickPick({
            title: INPUT_TITLE,
            step: input.getStepNumber(),
            totalSteps: state.totalSteps,
            placeholder: 'Pick type',
            items: types,
            activeItem: types[0]
        })).label;
        if (type) {
            if ('Manual' === type) {
                return (input: MultiStepInput) => inputBrokers(input, state, clusterSettings);
            } else {
                state.totalSteps = 1;
                state.connectionProviderId = 'redhat';
                const session = await authentication.getSession('redhat-account-auth', ['openid'], { createIfNone: true });
                if (!session) {
                    // window.showWarningMessage('You need to log into Red Hat first!');
                    return
                }
                const existingClusters = clusterSettings.getAll().map(cluster => cluster.bootstrap);
                let servers = await getRedHatManagedKafkaServer(session.accessToken);
                const foundServers = servers.length > 0;
                if (foundServers && existingClusters.length > 0) {
                    servers = servers.filter( mk => !existingClusters.includes(mk.bootstrapUrl));
                }
                if (servers.length == 1) {
                    const server = servers[0];
                    state.bootstrap = server.bootstrapUrl;
                    state.name = `${server.name} [Red Hat Managed Kafka]`;
                    await authentication.getSession('redhat-mas-account-auth', ['openid'], { createIfNone: true });
                } else if (servers.length > 1) {
                    const choices: QuickPickItem[] = servers.map((mk) => { return { label: mk.name, description: mk.bootstrapUrl }; });

                    const choice = (await input.showQuickPick({
                        title: 'Managed Kafka clusters',
                        step: input.getStepNumber(),
                        totalSteps: state.totalSteps,
                        placeholder: 'Select cluster',
                        items: choices,
                        activeItem: choices[0]
                    })).label;

                    if (choice) {
                        const server = servers.find(mk => mk.name === choice);
                        if (server) {
                            state.bootstrap = server.bootstrapUrl;
                            state.name = `${server.name} [Red Hat Managed Kafka]`;
                            await authentication.getSession('redhat-mas-account-auth', ['openid'], { createIfNone: true });
                        }
                    }
                } else if (foundServers) {
                    window.showInformationMessage('All Red Hat Kafka Clusters have already been added')
                    // Should open https://cloud.redhat.com/beta/application-services/openshift-streams
                } else {
                    window.showWarningMessage('No Red Hat Kafka cluster available! Visit https://cloud.redhat.com/beta/application-services/openshift-streams');
                }
            }
        }
    }
    interface ManagedKafka {
        name: string,
        bootstrapUrl: string
    }
    async function getRedHatManagedKafkaServer(token: string): Promise<ManagedKafka[]> {

        let requestConfig = {
            params: {
                orderBy: 'name asc'
            },
            headers: {
                'Authorization': `Bearer ${token}`,
                'Accept': 'application/json'
            }
        }
        const clusters: ManagedKafka[] = [];
        try {
            const kafkaApi = `https://api.stage.openshift.com/api/managed-services-api/v1/kafkas`;
            const response = await axios.get(kafkaApi, requestConfig);
            const kafkas = response.data;
            if (kafkas && kafkas.items && kafkas.items.length > 0) {
                kafkas.items.forEach((cluster: { status: string; name: any; bootstrapServerHost: any; }) => {
                    if (cluster?.status === 'ready') {
                        clusters.push({
                            name: cluster.name,
                            bootstrapUrl: cluster.bootstrapServerHost
                        });
                    }
                });
            }
        } catch (err) {
            window.showErrorMessage(`Failed to load Red Hat kafka clusters: ${err.message}`)
            throw err;
        }
        return clusters;
    }

    async function inputBrokers(input: MultiStepInput, state: Partial<AddClusterState>, clusterSettings: ClusterSettings) {
        state.bootstrap = await input.showInputBox({
            title: INPUT_TITLE,
            step: input.getStepNumber(),
            totalSteps: state.totalSteps,
            value: state.bootstrap ? state.bootstrap : DEFAULT_BROKER,
            prompt: 'Broker(s) (localhost:9092,localhost:9093...)',
            validate: validateBroker
        });
        return (input: MultiStepInput) => inputClusterName(input, state, clusterSettings);
    }

    async function inputClusterName(input: MultiStepInput, state: Partial<AddClusterState>, clusterSettings: ClusterSettings) {
        const existingClusterNames = clusterSettings.getAll().map(cluster => cluster.name);
        state.name = await input.showInputBox({
            title: INPUT_TITLE,
            step: input.getStepNumber(),
            totalSteps: state.totalSteps,
            value: state.name || '',
            prompt: 'Friendly name',
            validationContext: existingClusterNames,
            validate: validateClusterName
        });

        return (input: MultiStepInput) => inputAuthentification(input, state);
    }

    async function inputAuthentification(input: MultiStepInput, state: Partial<AddClusterState>) {
        const authMechanisms = new Map<string, string>([
            ["SASL/PLAIN", "plain"],
            ["SASL/SCRAM-256", "scram-sha-256"],
            ["SASL/SCRAM-512", "scram-sha-512"]
        ]);
        const authOptions: QuickPickItem[] = [{ "label": "None" }];
        for (const label of authMechanisms.keys()) {
            authOptions.push({ "label": label });
        }

        const authentification = (await input.showQuickPick({
            title: INPUT_TITLE,
            step: input.getStepNumber(),
            totalSteps: state.totalSteps,
            placeholder: 'Pick authentification',
            items: authOptions,
            activeItem: authOptions[0]
        })).label;
        if (authentification) {
            if (authentification === authOptions[0].label) {
                state.totalSteps = DEFAULT_STEPS;// we're on the 4-step track
                return (input: MultiStepInput) => inputSSL(input, state);
            } else {
                state.totalSteps = DEFAULT_STEPS + 1;// we're on the 5-step track
                state.saslOption = { mechanism: authMechanisms.get(authentification) as SaslMechanism };
                return (input: MultiStepInput) => inputAuthentificationUserName(input, state);
            }
        }
        return undefined;
    }

    async function inputAuthentificationUserName(input: MultiStepInput, state: Partial<AddClusterState>) {
        if (!state.saslOption) {
            return;
        }
        state.saslOption.username = await input.showInputBox({
            title: INPUT_TITLE,
            step: input.getStepNumber(),
            totalSteps: state.totalSteps,
            value: state.saslOption?.username || '',
            prompt: ' Username',
            validate: validateAuthentificationUserName
        });

        return (input: MultiStepInput) => inputAuthentificationPassword(input, state);
    }

    async function inputAuthentificationPassword(input: MultiStepInput, state: Partial<AddClusterState>) {
        if (!state.saslOption) {
            return;
        }
        state.saslOption.password = await input.showInputBox({
            title: INPUT_TITLE,
            step: input.getStepNumber(),
            totalSteps: state.totalSteps,
            value: state.saslOption.password || '',
            prompt: ' Password',
            password: true
        });
    }

    async function inputSSL(input: MultiStepInput, state: Partial<AddClusterState>) {
        const sslOptions: QuickPickItem[] = [{ "label": "Disabled" }, { "label": "Enabled" }];
        const ssl = (await input.showQuickPick({
            title: INPUT_TITLE,
            step: input.getStepNumber(),
            totalSteps: state.totalSteps,
            placeholder: 'SSL',
            items: sslOptions,
            activeItem: sslOptions[0]
        })).label;
        if (ssl) {
            state.ssl = ssl === sslOptions[1].label;
        }
    }

    try {
        await collectInputs(state, clusterSettings);
    } catch (e) {
        showErrorMessage('Error while collecting inputs for creating cluster', e);
        return;
    }

    const addClusterState: AddClusterState = state as AddClusterState;
    const bootstrap = state.bootstrap;
    if (!bootstrap) {
        return;
    }
    const name = state.name;
    if (!name) {
        return;
    }
    const saslOption = addClusterState.saslOption;
    const sanitizedName = name.replace(/[^a-zA-Z0-9]/g, "");
    const suffix = Buffer.from(bootstrap).toString("base64").replace(/=/g, "");

    try {
        clusterSettings.upsert({
            id: `${sanitizedName}-${suffix}`,
            bootstrap,
            connectionProviderId: state.connectionProviderId,
            name,
            saslOption,
            ssl: state.ssl
        });
        explorer.refresh();
        window.showInformationMessage(`Cluster '${name}' created successfully`);
        // Selecting the created cluster is done with TreeView#reveal
        // 1. Show the treeview of the explorer (otherwise reveal will not work)
        explorer.show();
        // 2. the reveal() call must occur within a timeout(),
        // while waiting for a fix in https://github.com/microsoft/vscode/issues/114149
        setTimeout(() => {
            explorer.selectClusterByName(name);
        }, 1000);
    }
    catch (error) {
        showErrorMessage(`Error while creating cluster`, error);
    }
}
