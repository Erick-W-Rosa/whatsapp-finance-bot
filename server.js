require("dotenv").config();
const express = require("express");
const axios = require("axios");

const app = express();
app.use(express.json());

const VERIFY_TOKEN = process.env.META_VERIFY_TOKEN;
const ACCESS_TOKEN = process.env.META_ACCESS_TOKEN;
const PHONE_NUMBER_ID = process.env.META_PHONE_NUMBER_ID;

async function sendWhatsAppMessage(to, body) {
  const response = await axios.post(
    `https://graph.facebook.com/v20.0/${PHONE_NUMBER_ID}/messages`,
    {
      messaging_product: "whatsapp",
      to,
      type: "text",
      text: {
        body
      }
    },
    {
      headers: {
        Authorization: `Bearer ${ACCESS_TOKEN}`,
        "Content-Type": "application/json"
      }
    }
  );

  console.log("Resposta da Meta:");
  console.log(JSON.stringify(response.data, null, 2));

  return response.data;
}

function getInitialReply(text) {
  return `Olá! Sou seu Assistente Financeiro IA 👋

Recebi sua mensagem:
"${text}"

Por enquanto estou em fase de teste, mas em breve vou conseguir:

• Lançar despesas
• Lançar receitas
• Consultar saldo
• Avisar contas vencendo
• Ler comprovantes
• Gerar prévia antes de salvar

Teste enviando algo como:

"Gastei 35 reais com lanche hoje"

ou

"Recebi 1500 de salário"`;
}

app.get("/webhook/whatsapp", (req, res) => {
  const mode = req.query["hub.mode"];
  const token = req.query["hub.verify_token"];
  const challenge = req.query["hub.challenge"];

  if (mode === "subscribe" && token === VERIFY_TOKEN) {
    console.log("Webhook verificado com sucesso.");
    return res.status(200).send(challenge);
  }

  console.log("Falha na verificação do webhook.");
  return res.sendStatus(403);
});

app.post("/webhook/whatsapp", async (req, res) => {
  console.log("==================================");
  console.log("WEBHOOK RECEBIDO");
  console.log(JSON.stringify(req.body, null, 2));
  console.log("==================================");

  try {
    const value = req.body?.entry?.[0]?.changes?.[0]?.value;
    const message = value?.messages?.[0];

    if (!message) {
      console.log("Nenhuma mensagem no payload.");
      return res.sendStatus(200);
    }

    console.log("Mensagem recebida:");
    console.log(JSON.stringify(message, null, 2));

    const from = message.from;

    if (message.type !== "text") {
      await sendWhatsAppMessage(
        from,
        `Recebi uma mensagem do tipo "${message.type}", mas por enquanto só estou tratando texto.

Em breve vou conseguir analisar áudio, imagem e comprovantes.`
      );

      return res.sendStatus(200);
    }

    const text = message.text?.body || "";

    console.log(`Recebido de ${from}: ${text}`);

    const reply = getInitialReply(text);

    await sendWhatsAppMessage(from, reply);

    console.log("Resposta enviada com sucesso.");

    return res.sendStatus(200);
  } catch (error) {
    console.error("Erro no webhook:");
    console.error(error.response?.data || error.message);
    return res.sendStatus(200);
  }
});

app.get("/", (req, res) => {
  res.send("Bot financeiro WhatsApp online");
});

const PORT = process.env.PORT || 3000;

app.listen(PORT, () => {
  console.log(`Servidor rodando na porta ${PORT}`);
});
