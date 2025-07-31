
# MongoDB TLS Proxy Service

Microserviço que atua como proxy TLS para conexões MongoDB, permitindo que Supabase Edge Functions se conectem via HTTP simples.

## Funcionalidades

- ✅ Conexões TLS com certificados customizados
- ✅ Suporte a certificados CA e client certificates
- ✅ API REST simples para operações MongoDB
- ✅ Gerenciamento de conexões ativas
- ✅ Limpeza automática de arquivos temporários
- ✅ Health checks e status monitoring

## Endpoints

### POST /connect
Estabelece conexão TLS com MongoDB
```json
{
  "connectionId": "unique-id",
  "mongoUrl": "mongodb://host:27017/db",
  "database": "database-name",
  "tlsConfig": {
    "enabled": true,
    "insecure": false,
    "caCert": "-----BEGIN CERTIFICATE-----\n...",
    "clientCert": "-----BEGIN CERTIFICATE-----\n..."
  }
}
```

### POST /query
Executa operações no MongoDB
```json
{
  "connectionId": "unique-id",
  "collection": "collection-name",
  "operation": "find|findOne|insertOne|updateOne|deleteOne|aggregate",
  "query": { "field": "value" },
  "options": { "limit": 10 }
}
```

### GET /collections/:connectionId
Lista collections disponíveis

### DELETE /disconnect/:connectionId
Encerra conexão e limpa recursos

### GET /status
Status do serviço

### GET /health
Health check

## Deploy na Vercel

1. Instale a Vercel CLI
2. Execute `vercel` na pasta do projeto
3. Configure as variáveis de ambiente se necessário

## Uso Local

```bash
npm install
npm start
```

O serviço estará disponível em http://localhost:3001
