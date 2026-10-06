# n8n-nodes-cosmosdb

Connect Azure Cosmos DB to your n8n workflows with advanced search capabilities including vector search, full-text search, and hybrid search using Reciprocal Rank Fusion (RRF).

## Features

✨ **Complete Document Management** - Query, create, update, and delete documents with ease

🔍 **Hybrid Search** - Combine keyword search and AI-powered semantic search for superior results

🤖 **AI Integration** - Automatic embedding generation with support for OpenAI, Azure OpenAI, and other embedding models

⚡ **Batch Processing** - Efficiently process multiple documents with batch embedding support

📦 **Container Management** - Create and manage containers with vector and full-text search policies

🛠️ **AI Agent Ready** - Works seamlessly as a tool for AI Agent workflows

## Included Nodes

This package currently ships three n8n nodes:

- **Cosmos DB** - Main operational node for document CRUD, SQL queries, container management, and hybrid search inside regular workflows
- **Cosmos DB Tool** - AI tool node for agent-driven Cosmos DB retrieval patterns
- **Cosmos DB Hybrid Search Tool** - Dedicated AI tool node focused on hybrid retrieval with separate semantic vector input and full-text keyword input

Use the dedicated **Cosmos DB Hybrid Search Tool** when you want an AI Agent to call a purpose-built hybrid retrieval tool instead of routing through the broader multi-operation node.

## What You Can Do

### Work with Documents (Item Operations)

- **Select** - Query documents using SQL
- **Create or Update** - Insert or update documents with automatic embedding generation
- **Hybrid Search** - Search using both keywords and semantic similarity
- **Set** - Update specific fields without replacing the entire document
- **Add** - Add new fields to existing documents
- **Delete** - Remove documents by ID

### Manage Containers

- **Create** - Set up containers with vector and full-text search indexes
- **Get** - Retrieve container configuration
- **Get Many** - List all containers in a database
- **Delete** - Remove containers

## Quick Start

### Installation

```bash
npm install n8n-nodes-cosmosdb
```

### Configuration

1. **Add Credentials** in n8n:
   - Create a new "Cosmos DB API" credential
   - Enter your Azure Cosmos DB **Endpoint** (e.g., `https://your-account.documents.azure.com:443/`)
   - Enter your **Primary Key** or **Secondary Key**

2. **Add the Node** to your workflow:
   - Search for "Cosmos DB" in the n8n node panel
   - Choose the node that matches your workflow:
     - `Cosmos DB` for standard database operations and regular n8n flows
     - `Cosmos DB Tool` for agent tool usage across multiple retrieval patterns
     - `Cosmos DB Hybrid Search Tool` for a dedicated AI hybrid-search tool

3. **(Optional) Connect an Embedding Model**:
   - Add an OpenAI Embeddings node (or Azure OpenAI, etc.)
   - Connect it to the "Embedding" input of the Cosmos DB node
   - Required for Hybrid Search and automatic embedding generation

## Operations Guide

### Select Documents

Query your Cosmos DB container using standard SQL syntax.

**What you can do:**

- Write custom SQL queries to filter and retrieve documents
- Limit results to a specific number
- Automatically clean up internal Cosmos DB fields
- Exclude specific fields to reduce payload size

**Example:**

```sql
SELECT * FROM c WHERE c.category = 'research' ORDER BY c._ts DESC
```

---

### Create or Update Documents

Insert new documents or update existing ones with automatic embedding generation.

**What you can do:**

- Upsert documents using JSON input (requires `id` and partition key)
- Automatically generate AI embeddings when connected to an embedding model
- Process multiple documents efficiently with batch embedding support
- Add custom text fields and metadata to documents

**Batch Processing Benefits:**

- Faster performance with parallel embedding generation
- Lower costs with fewer API calls
- Efficient handling of multiple documents

**Example:**

```json
Input:
{
  "id": "doc-123",
  "category": "AI",
  "title": "Machine Learning Basics"
}

With automatic embedding enabled:
{
  "id": "doc-123",
  "category": "AI",
  "title": "Machine Learning Basics",
  "text": "Introduction to ML",
  "vector": [0.123, -0.456, 0.789, ...]
}
```

---

### Hybrid Search

Combine keyword and AI-powered semantic search for superior results using Reciprocal Rank Fusion (RRF).

By default, hybrid search looks for full-text content in the `text` field and embeddings in the `vector` field. You can override both field names in the node when your documents use a different schema.

For AI Agent workflows, you can also use the dedicated **Cosmos DB Hybrid Search Tool** node. That node exposes a focused tool interface for hybrid retrieval and is designed specifically for agent tool-calling scenarios.

**What is RRF?**
RRF combines two ranking methods to give you the best of both worlds:

- **Keyword matching** - Find documents with specific terms
- **Semantic similarity** - Find documents with similar meaning

**What you can do:**

- Search by keywords and natural language queries simultaneously
- Filter results using custom SQL conditions
- Select specific fields to return (reduces response size)
- Control the number of results (Top K)
- Filter by partition key for faster queries

**Example:**

```
Keyword: "machine learning"
Search Query: "What is a neural network?"
Filters: c.published = true AND c.year > 2020
Fields: id, title, summary
Top Results: 10

Returns: Top 10 documents ranked by:
  ✓ Keyword relevance to "machine learning"
  ✓ Semantic similarity to "What is a neural network?"
  ✓ Pre-filtered for published docs from 2021+
  ✓ Only id, title, and summary fields included
```

---

### Update Specific Fields (Set)

Modify specific fields in a document without replacing the entire document.

**What you can do:**

- Update individual fields using JSON Pointer paths (e.g., `/status`, `/metadata/priority`)
- Modify nested fields at any depth
- Automatically handle different data types

**Example:**

```
Document ID: "doc-123"
Update: /status → "published"
        /metadata/reviewedBy → "John Doe"
        /priority → 5
```

---

### Add New Fields

Add new properties to existing documents without affecting other fields.

**What you can do:**

- Insert new fields at any level
- Add arrays, objects, or simple values
- Preserve existing document structure

**Example:**

```
Document ID: "doc-123"
Add: /tags → ["AI", "ML", "Research"]
     /metadata/lastUpdated → "2026-01-16"
```

---

### Delete Documents

Remove documents from your container.

**What you need:**

- Document ID
- Partition key value

**Example:**

```
ID: "doc-123"
Partition Key: "research"
Result: Document permanently deleted
```

---

## Container Management

### Create Container

Set up new containers with advanced search capabilities.

**What you can configure:**

- Partition key path
- Vector search policy (dimensions, distance function, index type)
- Full-text search policy
- Data types and indexing options

**Example:**

```
Container: Documents
Partition Key: /category
Vector Search: Enabled (1536 dimensions, cosine similarity)
Full-Text Search: Enabled on /text field
```

---

### Get Container

Retrieve container configuration and settings.

**Options:**

- View full container definition
- Simplified output with key fields only

---

### List All Containers

Get a list of all containers in your database with optional result limiting.

---

### Delete Container

Permanently remove a container and all its documents.

---

## Use as AI Agent Tool

This node works seamlessly with n8n AI Agents, allowing agents to search and retrieve information from your Cosmos DB knowledge base.

### Recommended AI Tool Node

For new agentic retrieval workflows, use **Cosmos DB Hybrid Search Tool** when you want a dedicated hybrid-search tool.

It is optimized for AI Agent use cases and accepts two explicit inputs:

- `vector` for the semantic query that will be embedded
- `fullText` for the short keyword query used by Cosmos DB full-text ranking

This separation improves agent prompting and makes the hybrid-search behavior more explicit than a single free-form input.

**How it works:**

1. Connect the node as a tool to your AI Agent
2. Connect an embedding model (OpenAI, Azure OpenAI, etc.)
3. The agent automatically uses hybrid search when needed
4. Results are returned to the agent for response generation

**Example Workflow:**

```
User asks: "What are the latest AI research papers?"
     ↓
AI Agent decides to search knowledge base
     ↓
Calls Cosmos DB hybrid search
     ↓
Returns relevant documents
     ↓
Agent formulates answer with retrieved context
```

---

## Container Setup for Hybrid Search

To use hybrid search, your Cosmos DB container needs both vector and full-text indexes:

**Required indexes:**

- Full-text index on text fields (for keyword search)
- Vector index on embedding fields (for semantic search)

**Example index policy:**

```json
{
	"indexingMode": "consistent",
	"automatic": true,
	"includedPaths": [{ "path": "/*" }],
	"vectorIndexes": [
		{
			"path": "/vector",
			"type": "quantizedFlat"
		}
	]
}
```

You can also create containers with the proper indexing policies directly using this node's **Create Container** operation

---

## Common Use Cases

**🤖 AI-Powered Knowledge Bases**

- Build conversational AI that searches your documents
- Combine keyword and semantic search for better results
- Integrate with AI Agents for intelligent assistance

**📚 Document Management Systems**

- Store and organize documents with metadata
- Query documents using SQL
- Automatically generate and store embeddings

**🔍 Semantic Search Applications**

- Enable natural language search across your content
- Find similar documents using AI embeddings
- Rank results by combined keyword and semantic relevance

**⚙️ Workflow Automation**

- Integrate Cosmos DB operations into n8n workflows
- Process documents with batch operations
- Trigger workflows based on document changes

---

## Troubleshooting

**"No embedding model connected"**

- Connect an embedding node (OpenAI, Azure OpenAI, etc.) to the Embedding input

**"Document must include partition key field"**

- Ensure your document includes the partition key field configured in your container
- Check that the field name matches exactly

**"Invalid JSON in Document field"**

- Validate your JSON syntax
- Ensure all quotes and brackets are properly closed

**Hybrid search not returning results**

- Verify your container has both full-text and vector indexes configured
- Check that documents have the expected full-text and vector fields, or set the hybrid search field names explicitly
- Ensure an embedding model is connected

**"Node does not have input of type" when running Cosmos DB Tool**

- Newer n8n versions (seen on 2.41.5) reject requests for connection inputs a node does not declare
- The Embeddings and Reranker inputs only exist when the operation is Hybrid Search, so Cosmos DB Tool now requests them only for that operation
- Update to the latest version of this package if you see this error on Select, Insert or other non-hybrid operations

---

## Requirements

- n8n version 1.0.0 or higher
- Azure Cosmos DB account with SQL API
- (Optional) Embedding model for hybrid search and automatic embedding generation

## Resources

- [Azure Cosmos DB Documentation](https://learn.microsoft.com/en-us/azure/cosmos-db/)
- [n8n Documentation](https://docs.n8n.io/)
- [Report Issues](https://github.com/wtyeung/n8n-node-cosmosdb/issues)

## License

MIT
