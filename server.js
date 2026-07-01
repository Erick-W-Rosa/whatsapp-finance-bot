require("dotenv").config();
const express = require("express");
const axios = require("axios");

const app = express();
app.use(express.json());

const VERIFY_TOKEN = process.env.META_VERIFY_TOKEN;
const ACCESS_TOKEN = process.env.META_ACCESS_TOKEN;
const PHONE_NUMBER_ID = process.env.META_PHONE_NUMBER_ID;

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

    if (message.type !== "text") {
      console.log(`Tipo de mensagem ainda não tratado: ${message.type}`);
      return res.sendStatus(200);
    }

    const from = message.from;
    const text = message.text?.body || "";

    console.log(`Recebido de ${from}: ${text}`);

    const response = await axios.post(
      `https://graph.facebook.com/v20.0/${PHONE_NUMBER_ID}/messages`,
      {
        messaging_product: "whatsapp",
        to: from,
        type: "text",
        text: {
          body: `Recebi sua mensagem: ${text}`
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
