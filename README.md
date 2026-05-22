# WhatsApp ERP Bot

Bot interno de WhatsApp Web com Baileys, Next.js e MongoDB, pensado para uso privado com ERP Flask.

## Arquitetura

- 1 WhatsApp
- 1 sessão
- 1 socket
- Persistência no MongoDB
- Reconnect automático com backoff
- Integração via API Bearer Token
- Compatibilidade com Render

## Recursos

- Conexao com WhatsApp via Baileys
- Sessao persistida no MongoDB
- Envio de mensagens via API
- Logs em MongoDB com TTL
- Endpoint de status
- Endpoint de health
- Reconnect manual

## Requisitos

- Node.js 20+
- MongoDB Atlas ou local

## Variaveis de ambiente

Crie um arquivo `.env` na raiz com:

```env
MONGODB_URI=mongodb+srv://user:password@cluster.mongodb.net/whatsapp_panel
MONGODB_DB=whatsapp_panel
PORT=3000
API_TOKEN=replace_with_a_strong_token
MESSAGE_LOG_TTL_DAYS=30
WHATSAPP_RECONNECT_BASE_MS=1500
WHATSAPP_RECONNECT_MAX_MS=60000
WHATSAPP_SEND_DELAY_MS=900
```

Se voce tiver legado usando `MONGO_URI`, o projeto tambem aceita esse nome.

## Execucao local

```bash
npm install
npm run dev
```

Abra:

- `http://localhost:3000/dashboard`

## API

Todos os endpoints protegidos aceitam:

```http
Authorization: Bearer SEU_TOKEN
```

### Status

```http
GET /status
```

Resposta compatível com o ERP:

```json
{
  "connected": true,
  "phone": "556892281187"
}
```

Tambem disponivel em:

- `GET /api/status`

### Sessao

Consulta o status da sessao unica do bot:

```http
GET /sessions/status
```

Tambem disponivel em:

- `GET /api/sessions/status`

### Logs

```http
GET /api/logs
```

### Enviar mensagem

```http
POST /send-message
```

Body:

```json
{
  "number": "556892281187",
  "message": "Teste local do ERP"
}
```

Tambem disponivel em:

- `POST /api/send-message`

### Reconnect manual

```http
POST /api/connect
```

### Healthcheck

```http
GET /health
```

Tambem disponivel em:

- `GET /api/health`

## Deploy no Render

1. Crie um novo Web Service.
2. Aponte para este repositorio.
3. Use Node.js.
4. Configure as variaveis de ambiente.
5. Build command:

```bash
npm install && npm run build
```

6. Start command:

```bash
npm start
```

## Integracao com ERP

No ERP Flask, configure:

```env
WHATSAPP_API_URL=https://seu-bot.onrender.com
WHATSAPP_API_TOKEN=mesmo_token_do_render
```

Para enviar mensagem, faca `POST` em `/send-message` com o header:

```http
Authorization: Bearer SEU_TOKEN
```
