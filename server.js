require("dotenv").config();
const express = require("express");
const axios = require("axios");
const OpenAI = require("openai");

const app = express();
app.use(express.json());

const VERIFY_TOKEN = process.env.META_VERIFY_TOKEN;
const ACCESS_TOKEN = process.env.META_ACCESS_TOKEN;
const PHONE_NUMBER_ID = process.env.META_PHONE_NUMBER_ID;
const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

const pendingActions = {};

async function sendWhatsAppMessage(to, body) {
  await axios.post(
    `https://graph.facebook.com/v20.0/${PHONE_NUMBER_ID}/messages`,
    {
      messaging_product: "whatsapp",
      to,
      type: "text",
      text: { body }
    },
    {
      headers: {
        Authorization: `Bearer ${ACCESS_TOKEN}`,
        "Content-Type": "application/json"
      }
    }
  );
}

async function interpretFinancialMessage(text) {
  const response = await openai.responses.create({
    model: "gpt-4.1-mini",
    input: `Interprete esta mensagem financeira em JSON:
"${text}"

Retorne SOMENTE JSON válido com:
{
  "action": "create_transaction | query | unknown",
  "type": "expense | income | debt | investment | transfer | null",
  "description": "string",
  "category": "string",
  "amount": number,
  "date": "today | yesterday | tomorrow | null",
  "status": "paid | pending | received | null",
  "installments": number | null,
  "confidence": number
}`
  });

  const content = response.output_text;
  return JSON.parse(content);
}

function formatPreview(data) {
  if (data.action === "unknown" || !data.amount) {
    return `Não consegui entender totalmente.

Tente assim:
"Gastei 35 reais com lanche hoje"
ou
"Recebi 1500 de salário"`;
  }

  const tipo =
    data.type === "expense" ? "Despesa" :
    data.type === "income" ? "Receita" :
    data.type === "debt" ? "Dívida" :
    data.type === "investment" ? "Investimento" :
    data.type === "transfer" ? "Transferência" :
    "Lançamento";

  const valor = Number(data.amount).toLocaleString("pt-BR", {
    style: "currency",
    currency: "BRL"
  });

  return `Encontrei:

Tipo: ${tipo}
Descrição: ${data.description || "-"}
Categoria: ${data.category || "-"}
Valor: ${valor}
Data: ${data.date || "hoje"}
Status: ${data.status || "-"}

Confirmar?
1 - Sim
2 - Cancelar`;
}

app.get("/webhook/whatsapp", (req, res) => {
  const mode = req.query["hub.mode"];
  const token = req.query["hub.verify_token"];
  const challenge = req.query["hub.challenge"];

  if (mode === "subscribe" && token === VERIFY_TOKEN) {
    return res.status(200).send(challenge);
  }

  return res.sendStatus(403);
});

app.post("/webhook/whatsapp", async (req, res) => {
  try {
    const value = req.body?.entry?.[0]?.changes?.[0]?.value;
    const message = value?.messages?.[0];

    if (!message) return res.sendStatus(200);

    const from = message.from;

    if (message.type !== "text") {
      await sendWhatsAppMessage(from, "Por enquanto estou entendendo apenas mensagens de texto.");
      return res.sendStatus(200);
    }

    const text = (message.text?.body || "").trim();

    if (text === "1" && pendingActions[from]) {
      const action = pendingActions[from];
      delete pendingActions[from];

      await sendWhatsAppMessage(
        from,
        `✅ Confirmado!

Ainda não salvei no Base44, mas a próxima etapa será gravar este lançamento no sistema:

${JSON.stringify(action, null, 2)}`
      );

      return res.sendStatus(200);
    }

    if (text === "2" && pendingActions[from]) {
      delete pendingActions[from];
      await sendWhatsAppMessage(from, "Lançamento cancelado.");
      return res.sendStatus(200);
    }

    const result = await interpretFinancialMessage(text);

    if (result.action === "create_transaction" && result.amount) {
      pendingActions[from] = result;
    }

    await sendWhatsAppMessage(from, formatPreview(result));
    return res.sendStatus(200);
  } catch (error) {
    console.error(error.response?.data || error.message);
    return res.sendStatus(200);
  }
});

app.get("/", (req, res) => {
  res.send("Bot financeiro WhatsApp online");
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Servidor rodando na porta ${PORT}`));
