import type {
	IDataObject,
	INodeType,
	INodeTypeDescription,
	ISupplyDataFunctions,
	IExecuteFunctions,
	SupplyData,
	INodeExecutionData,
	ILoadOptionsFunctions,
	INodePropertyOptions,
} from 'n8n-workflow';
import { NodeConnectionTypes, NodeOperationError, nodeNameToToolName } from 'n8n-workflow';
import { CosmosClient } from '@azure/cosmos';
import type { TokenCredential } from '@azure/core-auth';

interface ICosmosTokenData {
	accessToken: string;
	expiresAt?: string;
}

interface IEmbeddingModel {
	embedQuery(text: string): Promise<number[]>;
}

interface IRerankDocument {
	pageContent: string;
	metadata: Record<string, unknown>;
}

interface IRerankerModel {
	compressDocuments(documents: IRerankDocument[], query: string): Promise<IRerankDocument[]>;
}

class N8nCosmosTokenCredential implements TokenCredential {
	private readonly tokenSupplier: () => Promise<ICosmosTokenData>;

	constructor(
		accessTokenOrSupplier: string | (() => Promise<ICosmosTokenData> | ICosmosTokenData),
		private expiresAt?: string,
	) {
		if (typeof accessTokenOrSupplier === 'function') {
			this.tokenSupplier = async () => await accessTokenOrSupplier();
			return;
		}

		const normalizedAccessToken = accessTokenOrSupplier.replace(/^Bearer\s+/i, '');
		this.tokenSupplier = async () => ({
			accessToken: normalizedAccessToken,
			expiresAt: this.expiresAt,
		});
	}

	async getToken() {
		const { accessToken, expiresAt } = await this.tokenSupplier();
		const normalizedAccessToken = accessToken.replace(/^Bearer\s+/i, '');

		return {
			token: normalizedAccessToken,
			expiresOnTimestamp: expiresAt ? new Date(expiresAt).getTime() : Date.now() + 3600 * 1000,
		};
	}
}

function createEntraIdCosmosTokenCredential(
	context: {
		getCredentials(name: string): Promise<IDataObject>;
		getNode(): any;
	},
	missingTokenMessage = 'No valid Entra ID access token found.',
): N8nCosmosTokenCredential {
	return new N8nCosmosTokenCredential(async () => {
		const refreshedCredentials = await context.getCredentials('cosmosDbEntraIdApi');
		const refreshedTokenData = refreshedCredentials.oauthTokenData as Record<string, unknown>;

		if (!refreshedTokenData?.access_token) {
			throw new NodeOperationError(context.getNode(), missingTokenMessage);
		}

		return {
			accessToken: refreshedTokenData.access_token as string,
			expiresAt: refreshedTokenData.expires_at as string | undefined,
		};
	});
}

type JwtClaims = Record<string, unknown>;

function decodeJwtClaims(token?: string): JwtClaims {
	if (!token) {
		return {};
	}

	const tokenParts = token.split('.');
	if (tokenParts.length < 2 || !tokenParts[1]) {
		return {};
	}

	try {
		const normalizedPayload = tokenParts[1].replace(/-/g, '+').replace(/_/g, '/');
		const paddedPayload = normalizedPayload.padEnd(
			Math.ceil(normalizedPayload.length / 4) * 4,
			'=',
		);
		const payload = Buffer.from(paddedPayload, 'base64').toString('utf8');
		const parsedPayload = JSON.parse(payload);

		return typeof parsedPayload === 'object' && parsedPayload !== null ? parsedPayload : {};
	} catch {
		return {};
	}
}

function extractPreferredUserScopedName(
	oauthTokenData?: Record<string, unknown>,
): string | undefined {
	if (!oauthTokenData) {
		return undefined;
	}

	const directCandidate = [
		oauthTokenData.unique_name,
		oauthTokenData.preferred_username,
		oauthTokenData.email,
		oauthTokenData.upn,
	].find((value) => typeof value === 'string' && value.trim().length > 0) as string | undefined;

	const tokenClaims = [
		decodeJwtClaims(oauthTokenData.id_token as string | undefined),
		decodeJwtClaims(oauthTokenData.access_token as string | undefined),
	];

	const tokenCandidate = tokenClaims
		.map(
			(claims) =>
				[claims.unique_name, claims.preferred_username, claims.email, claims.upn].find(
					(value) => typeof value === 'string' && value.trim().length > 0,
				) as string | undefined,
		)
		.find((value) => Boolean(value));

	const preferredIdentity = directCandidate ?? tokenCandidate;
	if (!preferredIdentity) {
		return undefined;
	}

	const normalizedIdentity = preferredIdentity.trim().toLowerCase();
	if (!normalizedIdentity) {
		return undefined;
	}

	return normalizedIdentity;
}

function prioritizeMatchingOption(
	options: INodePropertyOptions[],
	preferredValue?: string,
	label = 'Suggested',
): INodePropertyOptions[] {
	if (!preferredValue) {
		return options;
	}

	const preferredIndex = options.findIndex(
		(option) =>
			typeof option.value === 'string' &&
			option.value.toLowerCase() === preferredValue.toLowerCase(),
	);

	if (preferredIndex <= 0) {
		if (preferredIndex === 0) {
			return [
				{
					...options[0],
					name: `${options[0].name} (${label})`,
				},
				...options.slice(1),
			];
		}

		return options;
	}

	const preferredOption = options[preferredIndex];
	return [
		{
			...preferredOption,
			name: `${preferredOption.name} (${label})`,
		},
		...options.slice(0, preferredIndex),
		...options.slice(preferredIndex + 1),
	];
}

function getValueByPath(source: unknown, path: string): unknown {
	if (!path) {
		return source;
	}

	return path.split('.').reduce<unknown>((current, segment) => {
		if (current === null || current === undefined) {
			return undefined;
		}

		if (Array.isArray(current)) {
			const index = Number(segment);
			return Number.isInteger(index) ? current[index] : undefined;
		}

		if (typeof current === 'object') {
			return (current as Record<string, unknown>)[segment];
		}

		return undefined;
	}, source);
}

function valueToRerankText(value: unknown): string {
	if (value === null || value === undefined) {
		return '';
	}

	if (typeof value === 'string') {
		return value;
	}

	if (typeof value === 'number' || typeof value === 'boolean') {
		return String(value);
	}

	return JSON.stringify(value);
}

async function rerankDocuments<T extends Record<string, unknown>>(
	documents: T[],
	reranker: IRerankerModel | undefined,
	query: string,
	preferredTextPath = '',
): Promise<T[]> {
	if (!reranker || documents.length === 0 || !query.trim()) {
		return documents;
	}

	const rerankInput: IRerankDocument[] = documents.map((document, index) => {
		const preferredValue = preferredTextPath
			? getValueByPath(document, preferredTextPath)
			: undefined;
		return {
			pageContent: valueToRerankText(preferredValue ?? document),
			metadata: { documentIndex: index },
		};
	});

	const reranked = await reranker.compressDocuments(rerankInput, query);
	const orderedDocuments: T[] = [];
	const usedIndexes = new Set<number>();

	for (const document of reranked) {
		const indexValue = Number(document.metadata.documentIndex);
		if (!Number.isInteger(indexValue) || usedIndexes.has(indexValue)) {
			continue;
		}

		const originalDocument = documents[indexValue];
		if (!originalDocument) {
			continue;
		}

		usedIndexes.add(indexValue);
		orderedDocuments.push(originalDocument);
	}

	for (const [index, document] of documents.entries()) {
		if (!usedIndexes.has(index)) {
			orderedDocuments.push(document);
		}
	}

	return orderedDocuments;
}

export class CosmosDbTool implements INodeType {
	description: INodeTypeDescription = {
		displayName: 'Cosmos DB Tool',
		name: 'cosmosDbTool',
		icon: { light: 'file:database.svg', dark: 'file:lightDatabase.svg' },
		group: ['transform'],
		version: 1,
		description: 'Cosmos DB retrieval tool for AI Agent workflows',
		defaults: { name: 'Cosmos DB Tool' },
		inputs: `={{
			((parameters) => {
				if (parameters?.operation === 'hybridSearch') {
					return [
						{ displayName: 'Embeddings', type: '${NodeConnectionTypes.AiEmbedding}', required: true, maxConnections: 1 },
						{ displayName: 'Reranker', type: '${NodeConnectionTypes.AiReranker}', required: false, maxConnections: 1 }
					];
				}
				return [];
			})($parameter)
		}}`,
		outputs: [NodeConnectionTypes.AiTool],
		credentials: [
			{
				name: 'cosmosDbApi',
				required: true,
				displayOptions: {
					show: {
						authenticationType: ['masterKey'],
					},
				},
			},
			{
				name: 'cosmosDbEntraIdApi',
				required: true,
				displayOptions: {
					show: {
						authenticationType: ['entraId'],
					},
				},
			},
		],
		properties: [
			{
				displayName: 'Authentication Type',
				name: 'authenticationType',
				type: 'options',
				options: [
					{ name: 'Master Key', value: 'masterKey' },
					{ name: 'Microsoft Entra ID (Azure AD)', value: 'entraId' },
				],
				default: 'masterKey',
				description: 'The authentication method to use for connecting to Cosmos DB',
			},
			{
				displayName: 'Operation',
				name: 'operation',
				type: 'options',
				options: [
					{ name: 'Select', value: 'select', action: 'Select documents' },
					{ name: 'Hybrid Search', value: 'hybridSearch', action: 'Hybrid search documents' },
				],
				default: 'select',
				noDataExpression: true,
			},
			{
				displayName: 'Tool Description',
				name: 'descriptionType',
				type: 'options',
				options: [
					{
						name: 'Automatically From Node Configuration',
						value: 'auto',
					},
					{
						name: 'Define Below',
						value: 'manual',
					},
				],
				default: 'auto',
				description: 'Whether to let n8n generate the tool description or define it manually',
			},
			{
				displayName: 'Tool Description',
				name: 'toolDescription',
				type: 'string',
				typeOptions: { rows: 3 },
				default: '',
				placeholder: 'Describe when the AI agent should use this tool and what inputs it expects',
				description: 'Custom description shown to the AI agent for tool selection and invocation',
				hint: 'Use this when the automatic description is not specific enough for the agent',
				displayOptions: {
					show: {
						descriptionType: ['manual'],
					},
				},
			},
			{
				displayName: 'Database Name or ID',
				name: 'databaseName',
				type: 'options',
				typeOptions: {
					loadOptionsDependsOn: [
						'authenticationType',
						'useDevOverride',
						'customEndpoint',
						'customAccessToken',
					],
					loadOptionsMethod: 'getDatabases',
				},
				default: '',
				placeholder: 'Select a database...',
				required: true,
				description:
					'Choose from the list, or specify an ID using an <a href="https://docs.n8n.io/code/expressions/">expression</a>',
				hint: 'This field supports expressions if you need to inject the database ID dynamically.',
			},
			{
				displayName: 'Container Name or ID',
				name: 'containerName',
				type: 'options',
				typeOptions: {
					loadOptionsDependsOn: [
						'databaseName',
						'authenticationType',
						'useDevOverride',
						'customEndpoint',
						'customAccessToken',
					],
					loadOptionsMethod: 'getContainers',
				},
				default: '',
				placeholder: 'Select a container...',
				required: true,
				description:
					'Choose from the list, or specify an ID using an <a href="https://docs.n8n.io/code/expressions/">expression</a>',
				hint: 'This field supports expressions if you need to inject the container ID dynamically.',
			},
			{
				displayName: 'SQL Query',
				name: 'sqlQuery',
				type: 'string',
				typeOptions: { rows: 5 },
				default: 'SELECT * FROM c',
				placeholder: 'SELECT * FROM c WHERE c.status = "active"',
				description:
					'The default SQL query to execute against the container when the tool input does not provide one',
				hint: 'This value is used as the fallback for structured tool calls',
				displayOptions: { show: { operation: ['select'] } },
			},
			{
				displayName: 'Return All',
				name: 'returnAll',
				type: 'boolean',
				default: true,
				description: 'Whether to return all results or only up to a given limit',
				displayOptions: { show: { operation: ['select'] } },
			},
			{
				displayName: 'Limit',
				name: 'limit',
				type: 'number',
				default: 50,
				typeOptions: { minValue: 1 },
				description: 'Max number of results to return',
				hint: 'This value is used when the tool input does not provide a limit',
				displayOptions: { show: { operation: ['select'], returnAll: [false] } },
			},
			{
				displayName: 'Keyword (Full Text Search)',
				name: 'keyword',
				type: 'string',
				default: '',
				placeholder: 'azure cosmos db vector search',
				description:
					'Default full-text keywords for hybrid search when the tool input does not provide them',
				hint: 'Leave empty to rely entirely on the tool call input',
				displayOptions: { show: { operation: ['hybridSearch'] } },
			},
			{
				displayName: 'Search Query (Vector Search)',
				name: 'searchQuery',
				type: 'string',
				default: '',
				placeholder: 'Find papers about retrieval-augmented generation',
				description: 'Default semantic search query when the tool input does not provide one',
				hint: 'Leave empty to rely entirely on the tool call input',
				displayOptions: { show: { operation: ['hybridSearch'] } },
			},
			{
				displayName: 'Vector Field Name',
				name: 'hybridVectorFieldName',
				type: 'string',
				default: 'vector',
				placeholder: 'vector',
				required: true,
				description: 'The document field used for vector search',
				displayOptions: { show: { operation: ['hybridSearch'] } },
			},
			{
				displayName: 'Full Text Field Name',
				name: 'hybridTextFieldName',
				type: 'string',
				default: 'text',
				placeholder: 'text',
				required: true,
				description: 'The document field used for full-text search',
				displayOptions: { show: { operation: ['hybridSearch'] } },
			},
			{
				displayName: 'Top K',
				name: 'topK',
				type: 'number',
				default: 10,
				typeOptions: { minValue: 1, maxValue: 1000 },
				description: 'Number of top results to retrieve from the database',
				hint: 'This value is used when the tool input does not provide topK',
				displayOptions: { show: { operation: ['hybridSearch'] } },
			},
			{
				displayName: 'Include Debug Info',
				name: 'includeDebugInfo',
				type: 'boolean',
				default: false,
				description:
					'Whether to include embedding, query, and result diagnostics in the tool response',
				displayOptions: { show: { operation: ['hybridSearch'] } },
			},
			{
				displayName: 'Partition Key Field',
				name: 'partitionKeyField',
				type: 'string',
				default: 'category',
				placeholder: 'category',
				description: 'The partition key field name used for optional filtering',
				displayOptions: { show: { operation: ['hybridSearch'] } },
			},
			{
				displayName: 'Partition Key Value',
				name: 'partitionKeyValue',
				type: 'string',
				default: '',
				placeholder: 'research',
				description: 'Optional partition key value for filtering',
				hint: 'Leave empty when you do not need partition filtering.',
				displayOptions: { show: { operation: ['hybridSearch'] } },
			},
			{
				displayName: 'Additional SQL Filters',
				name: 'additionalFilters',
				type: 'string',
				default: '',
				typeOptions: { rows: 3 },
				placeholder: 'c.published = true AND c.year > 2020',
				description: 'Optional SQL filters appended to the hybrid search query',
				hint: 'Use SQL conditions only, without the WHERE keyword.',
				displayOptions: { show: { operation: ['hybridSearch'] } },
			},
			{
				displayName: 'Fields to Return',
				name: 'fieldsToReturn',
				type: 'string',
				default: '',
				placeholder: 'ID, title, summary',
				description:
					'Optional comma-separated list of fields to return instead of the full document',
				hint: 'Leave empty to return full documents.',
				displayOptions: { show: { operation: ['hybridSearch'] } },
			},
			{
				displayName: 'Simplify Output',
				name: 'simplifyOutput',
				type: 'boolean',
				default: true,
				description: 'Whether to remove common Cosmos DB metadata fields from the output',
			},
			{
				displayName: 'Exclude Fields',
				name: 'excludeFields',
				type: 'boolean',
				default: false,
				description: 'Whether to exclude additional specific fields from the output',
			},
			{
				displayName: 'Fields to Exclude',
				name: 'fieldsToExclude',
				type: 'string',
				default: 'vector,text',
				placeholder: 'vector,text,rawContent',
				description: 'Comma-separated list of fields to exclude from the output',
				displayOptions: { show: { excludeFields: [true] } },
			},
			{
				displayName: 'Use Dev Override (Custom Endpoint + Token)',
				name: 'useDevOverride',
				type: 'boolean',
				default: false,
				description:
					'Whether to override the selected credentials with a custom endpoint and access token',
			},
			{
				displayName: 'Custom Endpoint',
				name: 'customEndpoint',
				type: 'string',
				default: '',
				placeholder: 'https://your-account.documents.azure.com:443/',
				description: 'The Cosmos DB account endpoint URL to use for the dev override',
				displayOptions: { show: { useDevOverride: [true] } },
			},
			{
				displayName: 'Custom Access Token',
				name: 'customAccessToken',
				type: 'string',
				typeOptions: { password: true },
				default: '',
				description: 'The bearer token to use with the custom endpoint override',
				displayOptions: { show: { useDevOverride: [true] } },
			},
		],
	};

	methods = {
		loadOptions: {
			async getDatabases(this: ILoadOptionsFunctions): Promise<INodePropertyOptions[]> {
				const authenticationType = this.getNodeParameter('authenticationType', 0) as string;
				let client: CosmosClient;
				let preferredUserScopedName: string | undefined;

				const customEndpoint = (
					(this.getNodeParameter('customEndpoint', '') as string) || ''
				).trim();
				const customAccessToken = (
					(this.getNodeParameter('customAccessToken', '') as string) || ''
				).trim();

				if (customEndpoint && customAccessToken) {
					preferredUserScopedName = extractPreferredUserScopedName({
						access_token: customAccessToken,
					});
					client = new CosmosClient({
						endpoint: customEndpoint,
						aadCredentials: new N8nCosmosTokenCredential(customAccessToken),
					});
				} else if (authenticationType === 'entraId') {
					const creds = await this.getCredentials('cosmosDbEntraIdApi');
					const endpoint = creds.endpoint as string;
					const oauthTokenData = creds.oauthTokenData as Record<string, unknown>;
					preferredUserScopedName = extractPreferredUserScopedName(oauthTokenData);
					client = new CosmosClient({
						endpoint,
						aadCredentials: createEntraIdCosmosTokenCredential(this),
					});
				} else {
					const credentials = await this.getCredentials('cosmosDbApi');
					client = new CosmosClient({
						endpoint: credentials.endpoint as string,
						key: credentials.key as string,
					});
				}

				try {
					const { resources } = await client.databases.readAll().fetchAll();
					const options = resources.map((database: { id: string }) => ({
						name: database.id,
						value: database.id,
					}));

					return prioritizeMatchingOption(options, preferredUserScopedName);
				} catch (error) {
					const message = error instanceof Error ? error.message : String(error);
					throw new NodeOperationError(this.getNode(), `Failed to load databases: ${message}`);
				}
			},

			async getContainers(this: ILoadOptionsFunctions): Promise<INodePropertyOptions[]> {
				const authenticationType = this.getNodeParameter('authenticationType', 0) as string;
				const databaseName = this.getCurrentNodeParameter('databaseName') as string;
				let preferredUserScopedName: string | undefined;

				if (!databaseName) {
					return [];
				}

				let client: CosmosClient;
				const customEndpoint = (
					(this.getNodeParameter('customEndpoint', '') as string) || ''
				).trim();
				const customAccessToken = (
					(this.getNodeParameter('customAccessToken', '') as string) || ''
				).trim();

				if (customEndpoint && customAccessToken) {
					preferredUserScopedName = extractPreferredUserScopedName({
						access_token: customAccessToken,
					});
					client = new CosmosClient({
						endpoint: customEndpoint,
						aadCredentials: new N8nCosmosTokenCredential(customAccessToken),
					});
				} else if (authenticationType === 'entraId') {
					const creds = await this.getCredentials('cosmosDbEntraIdApi');
					const endpoint = creds.endpoint as string;
					const oauthTokenData = creds.oauthTokenData as Record<string, unknown>;
					preferredUserScopedName = extractPreferredUserScopedName(oauthTokenData);
					client = new CosmosClient({
						endpoint,
						aadCredentials: createEntraIdCosmosTokenCredential(this),
					});
				} else {
					const credentials = await this.getCredentials('cosmosDbApi');
					client = new CosmosClient({
						endpoint: credentials.endpoint as string,
						key: credentials.key as string,
					});
				}

				try {
					const database = client.database(databaseName);
					const { resources } = await database.containers.readAll().fetchAll();
					const options = resources.map((container: { id: string }) => ({
						name: container.id,
						value: container.id,
					}));

					return prioritizeMatchingOption(options, preferredUserScopedName);
				} catch (error) {
					const message = error instanceof Error ? error.message : String(error);
					throw new NodeOperationError(this.getNode(), `Failed to load containers: ${message}`);
				}
			},
		},
	};

	async supplyData(this: ISupplyDataFunctions, itemIndex: number): Promise<SupplyData> {
		const operation = this.getNodeParameter('operation', itemIndex, 'select') as string;
		const authenticationType = this.getNodeParameter(
			'authenticationType',
			itemIndex,
			'masterKey',
		) as string;
		const customEndpoint = (
			this.getNodeParameter('customEndpoint', itemIndex, '') as string
		).trim();
		const customAccessToken = (
			this.getNodeParameter('customAccessToken', itemIndex, '') as string
		).trim();
		const databaseName = (this.getNodeParameter('databaseName', itemIndex, '') as string).trim();
		const containerName = (this.getNodeParameter('containerName', itemIndex, '') as string).trim();
		const simplifyOutput = this.getNodeParameter('simplifyOutput', itemIndex, true) as boolean;
		const excludeFields = this.getNodeParameter('excludeFields', itemIndex, false) as boolean;
		const fieldsToExclude = this.getNodeParameter('fieldsToExclude', itemIndex, '') as string;

		if (!databaseName || !containerName) {
			throw new NodeOperationError(
				this.getNode(),
				'Database Name and Container Name are required.',
			);
		}

		const isHybrid = operation === 'hybridSearch';
		const embeddings = isHybrid
			? ((await this.getInputConnectionData(NodeConnectionTypes.AiEmbedding, 0)) as
					| IEmbeddingModel
					| undefined)
			: undefined;
		const reranker = isHybrid
			? ((await this.getInputConnectionData(NodeConnectionTypes.AiReranker, 0)) as
					| IRerankerModel
					| undefined)
			: undefined;

		if (operation === 'hybridSearch' && !embeddings) {
			throw new NodeOperationError(
				this.getNode(),
				'Connect an Embeddings model to use Hybrid Search.',
			);
		}

		let client: CosmosClient;
		if (customEndpoint && customAccessToken) {
			client = new CosmosClient({
				endpoint: customEndpoint,
				aadCredentials: new N8nCosmosTokenCredential(customAccessToken),
			});
		} else if (authenticationType === 'entraId') {
			const entraIdCredentials = await this.getCredentials('cosmosDbEntraIdApi');
			const endpoint = entraIdCredentials.endpoint as string;
			const oauthTokenData = entraIdCredentials.oauthTokenData as Record<string, unknown>;

			if (!oauthTokenData?.access_token) {
				throw new NodeOperationError(this.getNode(), 'No valid Entra ID access token found.');
			}

			client = new CosmosClient({
				endpoint,
				aadCredentials: createEntraIdCosmosTokenCredential(this),
			});
		} else {
			const credentials = await this.getCredentials('cosmosDbApi');
			client = new CosmosClient({
				endpoint: credentials.endpoint as string,
				key: credentials.key as string,
			});
		}

		const container = client.database(databaseName).container(containerName);
		const defaultSqlQuery = this.getNodeParameter(
			'sqlQuery',
			itemIndex,
			'SELECT * FROM c',
		) as string;
		const returnAll = this.getNodeParameter('returnAll', itemIndex, true) as boolean;
		const limit = this.getNodeParameter('limit', itemIndex, 50) as number;
		const defaultKeyword = this.getNodeParameter('keyword', itemIndex, '') as string;
		const defaultSearchQuery = this.getNodeParameter('searchQuery', itemIndex, '') as string;
		const vectorFieldName = this.getNodeParameter(
			'hybridVectorFieldName',
			itemIndex,
			'vector',
		) as string;
		const textFieldName = this.getNodeParameter('hybridTextFieldName', itemIndex, 'text') as string;
		const topK = this.getNodeParameter('topK', itemIndex, 10) as number;
		const includeDebugInfo = this.getNodeParameter('includeDebugInfo', itemIndex, false) as boolean;
		const partitionKeyField = this.getNodeParameter(
			'partitionKeyField',
			itemIndex,
			'category',
		) as string;
		const partitionKeyValue = this.getNodeParameter('partitionKeyValue', itemIndex, '') as string;
		const additionalFilters = this.getNodeParameter('additionalFilters', itemIndex, '') as string;
		const fieldsToReturn = this.getNodeParameter('fieldsToReturn', itemIndex, '') as string;
		const descriptionType = this.getNodeParameter('descriptionType', itemIndex, 'auto') as string;
		const manualToolDescription = this.getNodeParameter('toolDescription', itemIndex, '') as string;

		const toolDescription =
			descriptionType === 'manual' && manualToolDescription.trim()
				? manualToolDescription.trim()
				: operation === 'hybridSearch'
					? `Search Azure Cosmos DB container "${containerName}" in database "${databaseName}" using hybrid full-text and vector search. ` +
						`Provide "query" (natural-language phrase for semantic vector search) and "keyword" (space-separated words for full-text ranking); "topK" is optional (default ${topK}).`
					: `Query Azure Cosmos DB container "${containerName}" in database "${databaseName}" using SQL select. ` +
						`"sqlQuery" is optional (defaults to the configured query); "rerankQuery" optionally reranks results.`;
		const executeTool = async (input: string | Record<string, unknown>): Promise<string> => {
			try {
				let parsed: Record<string, unknown> = {};
				const rawInput = typeof input === 'string' ? input.trim() : '';

				if (typeof input === 'string') {
					try {
						parsed = JSON.parse(input) as Record<string, unknown>;
					} catch {
						parsed = operation === 'hybridSearch' ? { query: input } : { sqlQuery: input };
					}
				} else if (input && typeof input === 'object') {
					parsed = input;
				}

				const stripOutput = (doc: Record<string, unknown>): Record<string, unknown> => {
					let cleaned = doc;
					if (simplifyOutput) {
						cleaned = { ...cleaned };
						for (const field of ['_rid', '_self', '_etag', '_attachments', '_ts']) {
							delete cleaned[field];
						}
					}

					if (excludeFields && fieldsToExclude) {
						cleaned = { ...cleaned };
						for (const field of fieldsToExclude
							.split(',')
							.map((item) => item.trim())
							.filter(Boolean)) {
							delete cleaned[field];
						}
					}

					return cleaned;
				};

				if (operation === 'hybridSearch') {
					const requestedKeyword = String(parsed.keyword ?? defaultKeyword ?? '').trim();
					const requestedQuery = String(
						parsed.query ?? parsed.searchQuery ?? defaultSearchQuery ?? '',
					).trim();
					const query = requestedQuery || requestedKeyword || rawInput;
					const keyword = requestedKeyword || query;
					const effectiveTopK = Number(parsed.topK ?? topK);
					const effectivePkValue = String(
						parsed.partitionKeyValue ?? partitionKeyValue ?? '',
					).trim();
					const effectiveFilters = String(
						parsed.additionalFilters ?? additionalFilters ?? '',
					).trim();
					const effectiveFieldsToReturn = String(
						parsed.fieldsToReturn ?? fieldsToReturn ?? '',
					).trim();

					const embedding = await embeddings!.embedQuery(query);
					const embeddingLiteral = `[${embedding.join(',')}]`;
					const safeKeyword = keyword
						.replace(/\\/g, '\\\\')
						.replace(/"/g, '\\"')
						.trim()
						.split(/\s+/)
						.filter(Boolean)
						.map((word) => `'${word}'`)
						.join(',');

					const conditions: string[] = [];
					if (effectivePkValue) {
						conditions.push(`c.${partitionKeyField}='${effectivePkValue.replace(/'/g, "''")}'`);
					}
					if (effectiveFilters) {
						conditions.push(`(${effectiveFilters})`);
					}

					let selectClause = '*';
					if (effectiveFieldsToReturn) {
						selectClause = effectiveFieldsToReturn
							.split(',')
							.map((field) => {
								const trimmed = field.trim();
								return trimmed.startsWith('c.') || /\s+AS\s+/i.test(trimmed)
									? trimmed
									: `c.${trimmed}`;
							})
							.join(', ');
					}

					const whereClause = conditions.length ? ` WHERE ${conditions.join(' AND ')}` : '';
					const sql =
						`SELECT TOP ${effectiveTopK} ${selectClause} FROM c${whereClause} ` +
						`ORDER BY RANK RRF(FullTextScore(c.${textFieldName}, ${safeKeyword}), ` +
						`VectorDistance(c.${vectorFieldName}, ${embeddingLiteral}))`;

					const hybridDebug = {
						query,
						keyword,
						topK: effectiveTopK,
						partitionKeyValue: effectivePkValue,
						additionalFilters: effectiveFilters,
						fieldsToReturn: effectiveFieldsToReturn,
						embeddingDimensions: embedding.length,
						sql,
					};

					const { resources } = await container.items.query(sql).fetchAll();
					if (!resources?.length) {
						return JSON.stringify(
							includeDebugInfo
								? {
										message: 'No results found',
										operation,
										query,
										debug: hybridDebug,
									}
								: { message: 'No results found', operation, query },
						);
					}

					const reranked = await rerankDocuments(
						resources as Array<Record<string, unknown>>,
						reranker,
						query,
						textFieldName,
					);

					const cleanedResults = reranked.map(stripOutput);
					return JSON.stringify(
						includeDebugInfo
							? {
									results: cleanedResults,
									debug: {
										...hybridDebug,
										resultCount: cleanedResults.length,
									},
								}
							: cleanedResults,
					);
				}

				const sql = String(parsed.sqlQuery ?? parsed.sql ?? defaultSqlQuery).trim();
				const rerankQuery = String(parsed.rerankQuery ?? parsed.query ?? '').trim();
				const { resources } = await container.items.query(sql).fetchAll();
				if (!resources?.length) {
					return JSON.stringify({ message: 'No results found', operation });
				}

				const limited = returnAll ? resources : resources.slice(0, limit);
				const reranked = await rerankDocuments(
					limited as Array<Record<string, unknown>>,
					reranker,
					rerankQuery,
				);

				return JSON.stringify(reranked.map(stripOutput));
			} catch (error) {
				const message = error instanceof Error ? error.message : String(error);
				throw new NodeOperationError(
					this.getNode(),
					`Cosmos DB Tool failed during ${operation}: ${message}`,
				);
			}
		};

		const toolName = nodeNameToToolName(this.getNode());

		const { DynamicStructuredTool } = require('@langchain/core/tools') as {
			DynamicStructuredTool: new (config: {
				name: string;
				description: string;
				schema: unknown;
				func: (input: Record<string, unknown> | string) => Promise<string>;
			}) => { name: string };
		};

		const tool = new DynamicStructuredTool({
			name: toolName,
			description: toolDescription,
			// Plain JSON Schema (type: object) — required by OpenAI function calling
			schema:
				operation === 'hybridSearch'
					? {
							type: 'object',
							properties: {
								query: {
									type: 'string',
									description: 'Natural-language phrase used for semantic vector embedding search',
								},
								keyword: {
									type: 'string',
									description: 'Space-separated words used for full-text RRF ranking',
								},
								topK: { type: 'number', description: `Max results (default ${topK})` },
								partitionKeyValue: {
									type: 'string',
									description: 'Optional partition key value to filter by',
								},
								additionalFilters: {
									type: 'string',
									description: 'Optional extra SQL WHERE condition, e.g. c.status = "active"',
								},
								fieldsToReturn: {
									type: 'string',
									description: 'Optional comma-separated fields to return',
								},
							},
						}
					: {
							type: 'object',
							properties: {
								sqlQuery: {
									type: 'string',
									description:
										'Optional Cosmos DB SQL query. Omit to use the query configured on the node.',
								},
								rerankQuery: {
									type: 'string',
									description: 'Optional phrase used to rerank results',
								},
							},
						},
			func: async (rawInput: Record<string, unknown> | string): Promise<string> => {
				let parsed: Record<string, unknown> = {};
				if (typeof rawInput === 'string') {
					try {
						parsed = JSON.parse(rawInput) as Record<string, unknown>;
					} catch {
						parsed = operation === 'hybridSearch' ? { query: rawInput } : { sqlQuery: rawInput };
					}
				} else {
					parsed = rawInput ?? {};
				}
				const inputJson: IDataObject = parsed as IDataObject;
				const { index } = this.addInputData(NodeConnectionTypes.AiTool, [[{ json: inputJson }]]);
				try {
					const response = await executeTool(parsed);
					void this.addOutputData(NodeConnectionTypes.AiTool, index, [[{ json: { response } }]]);
					return response;
				} catch (error) {
					const executionError =
						error instanceof NodeOperationError
							? error
							: new NodeOperationError(this.getNode(), error as Error);
					void this.addOutputData(NodeConnectionTypes.AiTool, index, executionError);
					throw executionError;
				}
			},
		});

		return { response: tool };
	}

	/**
	 * Called by n8n's engine when an AI agent invokes this tool via EngineRequest.
	 * Tool arguments arrive as getInputData()[0].json; reuse the supplyData tool so both paths behave identically.
	 */
	async execute(this: IExecuteFunctions): Promise<INodeExecutionData[][]> {
		const json = (this.getInputData()[0]?.json ?? {}) as Record<string, unknown>;
		const { input, ...fields } = json;
		const isHybrid = this.getNodeParameter('operation', 0, 'select') === 'hybridSearch';
		const args: Record<string, unknown> =
			typeof input === 'string' && !Object.keys(fields).length
				? isHybrid
					? { query: input }
					: { sqlQuery: input }
				: { ...fields };

		const context = new Proxy(this, {
			get: (target, prop) => {
				if (prop === 'addInputData') return () => ({ index: 0 });
				if (prop === 'addOutputData') return () => undefined;
				const value = (target as unknown as Record<string | symbol, unknown>)[prop];
				return typeof value === 'function' ? value.bind(target) : value;
			},
		}) as unknown as ISupplyDataFunctions;

		const { response } = await CosmosDbTool.prototype.supplyData.call(context, 0);
		const result = await (
			response as { invoke: (input: Record<string, unknown> | string) => Promise<string> }
		).invoke(args);

		let parsed: unknown;
		try {
			parsed = JSON.parse(result);
		} catch {
			parsed = { response: result };
		}
		const docs = Array.isArray(parsed) ? parsed : [parsed];
		return [docs.map((doc) => ({ json: doc as IDataObject }))];
	}
}
