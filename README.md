# WhatsApp ERP Gateway

Gateway HTTP para o WhatsApp Business Platform da Meta, com Next.js e MongoDB, pensado para integrar com ERP sem mudar o contrato da API existente.

## Arquitetura

- ERP chama esta API por HTTP
- Esta API chama a Meta Graph API
- Nenhum fluxo de WhatsApp Web ou Baileys
- Logs persistidos em MongoDB
- Autenticacao por Bearer token

## Variaveis de ambiente

```env
MONGODB_URI=mongodb+srv://user:password@cluster.mongodb.net/whatsapp_panel
MONGODB_DB=whatsapp_panel
PORT=3000
API_TOKEN=replace_with_a_strong_token
META_ACCESS_TOKEN=replace_with_meta_access_token
META_PHONE_NUMBER_ID=replace_with_phone_number_id
META_BUSINESS_ID=replace_with_business_id
META_API_VERSION=v23.0
META_WEBHOOK_VERIFY_TOKEN=replace_with_webhook_verify_token
MESSAGE_LOG_TTL_DAYS=30
```

`MONGO_URI` continua aceito como fallback.

## Execucao local

```bash
npm install
npm run dev
```

Dashboard:

- `http://localhost:3000/dashboard`

## Endpoints principais

Todos os endpoints protegidos aceitam:

```http
Authorization: Bearer SEU_TOKEN
```

### Status

```http
GET /status
```

Resposta:

```json
{
  "connected": true,
  "provider": "meta",
  "phone": "556899999999"
}
```

Tambem disponivel em:

- `GET /api/status`

### Health

```http
GET /health
```

Resposta:

```json
{
  "status": "ok",
  "provider": "meta"
}
```

Tambem disponivel em:

- `GET /api/health`

### Enviar texto

```http
POST /send-message
```

Body:

```json
{
  "number": "556899999999",
  "message": "Ola"
}
```

Tambem disponivel em:

- `POST /api/send-message`

### Enviar documento

```http
POST /send-document
```

Body:

```json
{
  "number": "556899999999",
  "document": "https://site.com/nfce.pdf",
  "filename": "NFC-e.pdf",
  "caption": "Segue sua nota fiscal."
}
```

### Enviar imagem

```http
POST /send-image
```

### Enviar template

```http
POST /send-template
```

### Webhook oficial

```http
GET /webhook
POST /webhook
```

O `GET` responde ao desafio de verificacao da Meta usando `META_WEBHOOK_VERIFY_TOKEN`.

### Logs

```http
GET /api/logs
```

### Validar credenciais

```http
POST /api/connect
```

## Integracao com ERP

Sem mudancas no ERP. Continue enviando:

```http
POST /send-message
Authorization: Bearer SEU_TOKEN
```

com o mesmo payload atual.
