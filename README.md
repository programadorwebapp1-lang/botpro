# WhatsApp ERP Bot

Sistema interno de WhatsApp Web com Baileys, Next.js, MongoDB e Socket.IO, pensado para uso privado com ERP Flask.

## Recursos

- Conexão com WhatsApp via Baileys
- Sessão persistida no MongoDB
- Reconexão automática com backoff
- QR Code no dashboard
- Envio de mensagens via API
- Logs em MongoDB com TTL
- Autenticação por `Authorization: Bearer`
- Atualização em tempo real com Socket.IO

## Requisitos

- Node.js 20+
- MongoDB Atlas ou local

## Variáveis de ambiente

Crie um arquivo `.env` na raiz com:

```env
MONGODB_URI=mongodb+srv://user:password@cluster.mongodb.net/whatsapp_panel
MONGODB_DB=whatsapp_panel
PORT=3000
WHATSAPP_SESSION_ID=primary
API_TOKEN=replace_with_a_strong_token
MESSAGE_LOG_TTL_DAYS=30
WHATSAPP_RECONNECT_BASE_MS=1500
WHATSAPP_RECONNECT_MAX_MS=60000
WHATSAPP_SEND_DELAY_MS=900
```

Se você tiver legado usando `MONGO_URI`, o projeto também aceita esse nome.

## Execução local

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
  "numero": "5599999999999",
  "mensagem": "Teste"
}
```

### Reconnect manual

```http
POST /api/connect
```

### Healthcheck

```http
GET /health
```

## Deploy no Render

1. Crie um novo Web Service.
2. Aponte para este repositório.
3. Use Node.js.
4. Configure as variáveis de ambiente.
5. Build command:

```bash
npm install && npm run build
```

6. Start command:

```bash
npm start
```

## Integração com ERP

No ERP Flask, configure:

```env
WHATSAPP_API_URL=https://seu-bot.onrender.com
WHATSAPP_API_TOKEN=mesmo_token_do_render
```

Para enviar mensagem, faça `POST` em `/send-message` com o header:

```http
Authorization: Bearer SEU_TOKEN
```
