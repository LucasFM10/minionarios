# Minionários · Noite do Hambúrguer 🍔

Cardápio digital de pré-venda, painel de pedidos e bot de WhatsApp da equipe **Minionários** (Gincana do EJC, Paróquia São Pedro Pescador).

- **Cardápio (mobile first)** — `/`: sacola, dados do cliente, Pix (QR Code com valor + copia e cola), envio do comprovante e número de pedido sequencial (`#001`…`#999`).
- **Acompanhar pedido** — `/pedido`: linha do tempo do status, atualização automática, envio de comprovante pendente, busca por número + telefone.
- **Painel admin** — `/admin`: pedidos em tempo real (aviso sonoro), filtros por status, avanço de status em 1 toque, visualização do comprovante, pedido manual, resumo de vendas/produção, exportação CSV, edição do cardápio (fotos, preços, visibilidade) e configurações (Pix, textos, abrir/fechar pré-venda).
- **Bot WhatsApp (Evolution API)** — só responde mensagens recebidas: faz pedido pelo chat, envia QR Code + Pix copia e cola, recebe o comprovante (foto/PDF) e consulta status.

Status: `Pedido feito → Pagamento confirmado → Em preparo → Saiu para a entrega → Concluído` (+ `Cancelado`).

## Rodando

```bash
npm install
ADMIN_PASSWORD=senha npm start   # http://localhost:3000
```

### Variáveis de ambiente

| Variável | Descrição |
|---|---|
| `ADMIN_PASSWORD` | Senha do painel `/admin` (obrigatória) |
| `PUBLIC_URL` | URL pública, ex.: `https://minionarios.lucasfm10.com.br` (links e webhook) |
| `EVOLUTION_URL` | URL da Evolution API v2 |
| `EVOLUTION_API_KEY` | API key global da Evolution |
| `EVOLUTION_INSTANCE` | Nome da instância (padrão `minionarios`) |
| `WHATSAPP_NUMBER` | Número da equipe (com 55). Se definido, o admin mostra um **código de pareamento** além do QR |
| `WEBHOOK_SECRET` | Token do webhook (opcional; derivado das outras chaves se ausente) |
| `DATA_DIR` | Pasta do SQLite e uploads (padrão `./data`; no Docker `/app/data` — monte um volume) |

### WhatsApp

Na inicialização o app cria a instância na Evolution e registra o webhook sozinho. Só falta vincular o número: em **Admin › WhatsApp › Mostrar QR Code**, leia o QR ou digite o código de pareamento no celular (WhatsApp › Aparelhos conectados).

Fluxo do site: o cliente fecha o pedido (gera o número), toca em **Concluir pedido no WhatsApp** e envia a mensagem pronta; o bot responde com o Pix e pede o comprovante na conversa.

1. Configure as variáveis da Evolution e abra **Admin › WhatsApp**.
2. Clique **Criar instância** (cria a instância e registra o webhook `PUBLIC_URL/api/whatsapp/webhook`).
3. Clique **Mostrar QR Code** e leia com o WhatsApp da equipe (Aparelhos conectados).

### Regras do bot

- **Nunca envia mensagem por conta própria**: só responde a quem escreveu primeiro (evita banimento). Mudanças de status no painel não geram aviso automático — a equipe avisa manualmente.
- **Falar com a equipe** (opção *4*, "atendente", "cancelar" com pedido ativo): o bot avisa que um humano vai responder e **pausa**. O painel marca "🙋 Pediu ajuda". Se a equipe responder pelo celular, vira "💬 Equipe atendendo". Em *Conversas* use "Resolvido — retomar bot" (retoma sozinho após 8 h).
- **Conversas**: todas as mensagens e mídias (comprovantes, fotos) ficam salvas e aparecem em *Admin › Conversas* (somente leitura).
- **Taxa de entrega**: distância de carro (OpenStreetMap/Nominatim + OSRM) × R$ 1,00/km, arredondada para cima de R$ 0,50. Ajustável em *Ajustes* (valor/km, arredondamento, taxa mínima, distância máxima, coordenadas da retirada). Se o endereço não for localizado, fica "taxa a combinar".
- Pedidos sem comprovante há mais de 2 h aparecem destacados no painel.

## Deploy

`Dockerfile` pronto (porta 3000, healthcheck em `/api/health`). No Coolify, use build pack *Dockerfile* e um volume persistente em `/app/data`.

## Testes

```bash
npm test
```
