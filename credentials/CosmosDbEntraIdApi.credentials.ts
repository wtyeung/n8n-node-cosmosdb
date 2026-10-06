import type { IAuthenticateGeneric, ICredentialType, INodeProperties } from 'n8n-workflow';

export class CosmosDbEntraIdApi implements ICredentialType {
	name = 'cosmosDbEntraIdApi';
	displayName = 'Cosmos DB (Microsoft Entra ID / Azure AD) API';
	documentationUrl = 'https://learn.microsoft.com/en-us/azure/cosmos-db/how-to-setup-rbac';
	extends = ['microsoftOAuth2Api'];
	properties: INodeProperties[] = [
		// Hidden OAuth2 config fields with noDataExpression to prevent URL bloat (431 errors)
		{
			displayName: 'Grant Type',
			name: 'grantType',
			type: 'hidden',
			default: 'authorizationCode',
			noDataExpression: true,
		},
		{
			displayName: 'Authorization URL',
			name: 'authUrl',
			type: 'hidden',
			default: 'https://login.microsoftonline.com/common/oauth2/v2.0/authorize',
			noDataExpression: true,
		},
		{
			displayName: 'Access Token URL',
			name: 'accessTokenUrl',
			type: 'hidden',
			default: 'https://login.microsoftonline.com/common/oauth2/v2.0/token',
			noDataExpression: true,
		},
		{
			displayName: 'Authentication',
			name: 'authentication',
			type: 'hidden',
			default: 'body',
			noDataExpression: true,
		},
		{
			displayName: 'Scope',
			name: 'scope',
			type: 'hidden',
			default:
				'={{$self.apiScope.includes("offline_access") ? $self.apiScope : "offline_access " + $self.apiScope}}',
		},
		{
			displayName: 'API Scope',
			name: 'apiScope',
			type: 'hidden', // Changed to hidden
			required: true,
			default: 'https://cosmos.azure.com/user_impersonation',
			noDataExpression: true,
		},
		{
			displayName: 'Endpoint',
			name: 'endpoint',
			type: 'string',
			default: '',
			required: true,
			placeholder: 'https://your-account.documents.azure.com:443/',
			description: 'The Cosmos DB account endpoint URL',
			noDataExpression: true,
		},
		{
			displayName: 'Token Refresh Buffer (seconds)',
			name: 'refreshBeforeExpirySeconds',
			type: 'number',
			typeOptions: {
				minValue: 60,
				maxValue: 3600,
			},
			default: 900,
			description:
				'How many seconds before token expiry to proactively refresh the token. This prevents the token from expiring in the middle of a workflow execution. Default: 900 (15 minutes). Range: 60–3600.',
			placeholder: '900',
			hint: 'Set based on your workflow duration: Long workflows (30–60 min) → 1800–3600, Quick workflows (5–10 min) → 300–600',
			noDataExpression: true,
		},
	];

	authenticate: IAuthenticateGeneric = {
		type: 'generic',
		properties: {
			headers: {
				Authorization: '=type=aad&ver=1.0&sig={{$credentials.oauthTokenData.access_token}}',
			},
		},
	};
}
