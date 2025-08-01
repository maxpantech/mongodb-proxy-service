
# MongoDB TLS Proxy Service

Microserviço Node.js deployado na Vercel que atua como proxy TLS para conexões MongoDB.

## Deploy na Vercel

1. Instale a Vercel CLI:
```bash
npm i -g vercel
```

2. Faça login na Vercel:
```bash
vercel login
```

3. Na pasta `mongodb-proxy-service`, execute:
```bash
vercel --prod
```

4. A Vercel irá gerar uma URL como: `https://mongodb-tls-proxy.vercel.app`

## Configuração no Supabase

Após o deploy, configure o secret `MONGODB_PROXY_URL` no Supabase Edge Functions:

```
MONGODB_PROXY_URL=https://sua-url-gerada.vercel.app
```

## Endpoints Disponíveis

- `GET /` - Informações do serviço
- `GET /status` - Status detalhado
- `GET /health` - Health check
- `POST /connect` - Estabelecer conexão TLS
- `POST /query` - Executar operações
- `GET /collections/:id` - Listar collections
- `DELETE /disconnect/:id` - Desconectar

## Teste Local

```bash
npm install
npm start
```

O serviço estará disponível em http://localhost:3001
