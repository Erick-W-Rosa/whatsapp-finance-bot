require("dotenv").config();
const express = require("express");
const axios = require("axios");
const { GoogleGenAI } = require("@google/genai");

const app = express();
app.use(express.json());

const VERIFY_TOKEN = process.env.META_VERIFY_TOKEN;
const ACCESS_TOKEN = process.env.META_ACCESS_TOKEN;
const PHONE_NUMBER_ID = process.env.META_PHONE_NUMBER_ID;
const GEMINI_API_KEY = process.env.GEMINI_API_KEY;

const ai = new GoogleGenAI({
  apiKey: GEMINI_API_KEY
});

// Ações pendentes em memória.
// Depois podemos trocar por banco de dados.
const pendingActions = {};

async function sendWhatsAppMessage(to, body) {
  const response = await axios.post(
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

  console.log("Resposta da Meta:");
  console.log(JSON.stringify(response.data, null, 2));

  return response.data;
}

function cleanJson(text) {
  return text
    .replace(/```json/g, "")
    .replace(/```/g, "")
    .trim();
}

async function interpretFinancialMessage(text) {
  if (!GEMINI_API_KEY) {
    throw new Error("GEMINI_API_KEY não configurada.");
  }

  const prompt = `
Você é um assistente financeiro brasileiro.

Interprete a mensagem abaixo e retorne SOMENTE JSON válido.
Não use markdown.
Não explique nada fora do JSON.

Mensagem do usuário:
"${text}"

Regras:
- Se for gasto, use type = "expense".
- Se for dinheiro recebido, use type = "income".
- Se for empréstimo, financiamento ou dívida, use type = "debt".
- Se for aplicação, investimento, CDB, poupança, ações ou cripto, use type = "investment".
- Se for transferência entre contas, use type = "transfer".
- Se não entender, use action = "unknown".

Categorias sugeridas:
Alimentação, Mercado, Lazer, Saúde, Transporte, Combustível, Moradia, Salário, Renda Extra, Assinaturas, Investimentos, Dívidas, Outros.

Datas:
- hoje = "today"
- ontem = "yesterday"
- amanhã = "tomorrow"
- se não informar data, use "today"

Status:
- se parecer que já pagou/gastou/recebeu, use "paid" para despesa ou "received" para receita
- se for algo a pagar no futuro, use "pending"

Formato obrigatório:

{
  "action": "create_transaction",
  "type": "expense",
  "description": "Lanche",
  "category": "Alimentação",
  "amount": 35,
  "date": "today",
  "status": "paid",
  "payment_method": null,
  "account": null,
  "card": null,
  "installments": null,
  "confidence": 0.95
}

Para consultas, use:
{
  "action": "query",
  "query_type": "balance | expenses_month | income_month | due_bills | summary | unknown",
  "period": "current_month",
  "confidence": 0.9
}

Para desconhecido:
{
  "action": "unknown",
  "type": null,
  "description": null,
  "category": null,
  "amount": null,
  "date": null,
  "status": null,
  "payment_method": null,
  "account": null,
  "card": null,
  "installments": null,
  "confidence": 0
}
`;

  const response = await ai.models.generateContent({
    model: "gemini-2.5-flash",
    contents: prompt,
    config: {
      responseMimeType: "application/json"
    }
  });

  const content = cleanJson(response.text || "");
  return JSON.parse(content);
}

function formatPreview(data) {
  if (!data || data.action === "unknown") {
    return `Não consegui entender totalmente.

Tente enviar assim:

"Gastei 35 reais com lanche hoje"

ou

"Recebi 1500 de salário"`;
  }

  if (data.action === "query") {
    return `Entendi que você quer fazer uma consulta financeira.

Tipo de consulta: ${data.query_type || "não informado"}
Período: ${data.period || "mês atual"}

Ainda não conectei com o banco/Base44 para buscar esses dados.

Próxima etapa: integrar consultas reais do seu sistema financeiro.`;
  }

  if (data.action !== "create_transaction" || !data.amount) {
    return `Entendi parte da mensagem, mas faltou alguma informação importante.

Tente informar o valor e o tipo, exemplo:

"Gastei 35 reais com mercado hoje"`;
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

  const dataTexto =
    data.date === "today" ? "Hoje" :
    data.date === "yesterday" ? "Ontem" :
    data.date === "tomorrow" ? "Amanhã" :
    data.date || "Hoje";

  const statusTexto =
    data.status === "paid" ? "Pago" :
    data.status === "received" ? "Recebido" :
    data.status === "pending" ? "Pendente" :
    data.status || "-";

  return `Encontrei este lançamento:

Tipo: ${tipo}
Descrição: ${data.description || "-"}
Categoria: ${data.category || "-"}
Valor: ${valor}
Data: ${dataTexto}
Status: ${statusTexto}
Forma de pagamento: ${data.payment_method || "-"}
Conta: ${data.account || "-"}
Cartão: ${data.card || "-"}
Parcelas: ${data.installments || "-"}

Confirmar?
1 - Sim
2 - Cancelar`;
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
  try {
    console.log("==================================");
    console.log("WEBHOOK RECEBIDO");
    console.log(JSON.stringify(req.body, null, 2));
    console.log("==================================");

    const value = req.body?.entry?.[0]?.changes?.[0]?.value;
    const message = value?.messages?.[0];

    if (!message) {
      console.log("Nenhuma mensagem no payload.");
      return res.sendStatus(200);
    }

    const from = message.from;

    if (message.type !== "text") {
      await sendWhatsAppMessage(
        from,
        `Recebi uma mensagem do tipo "${message.type}", mas por enquanto estou interpretando apenas texto.

Em breve vou analisar comprovantes, imagens e áudios.`
      );

      return res.sendStatus(200);
    }

    const text = (message.text?.body || "").trim();

    console.log(`Recebido de ${from}: ${text}`);

    if (text === "1" && pendingActions[from]) {
      const action = pendingActions[from];
      delete pendingActions[from];

      await sendWhatsAppMessage(
        from,
        `✅ Confirmado!

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

    console.log("Resultado da IA:");
    console.log(JSON.stringify(result, null, 2));

    if (result.action === "create_transaction" && result.amount) {
      pendingActions[from] = result;
    }

    const reply = formatPreview(result);

    await sendWhatsAppMessage(from, reply);

    return res.sendStatus(200);
  } catch (error) {
    console.error("Erro no webhook:");
    console.error(error.response?.data || error.message);

    try {
      const value = req.body?.entry?.[0]?.changes?.[0]?.value;
      const message = value?.messages?.[0];
      const from = message?.from;

      if (from) {
        await sendWhatsAppMessage(
          from,
          "⚠️ Tive um problema ao interpretar sua mensagem agora. Tente novamente em alguns instantes."
        );
      }
    } catch (sendError) {
      console.error("Erro ao enviar mensagem de erro:");
      console.error(sendError.response?.data || sendError.message);
    }

    return res.sendStatus(200);
  }
});

app.get("/", (req, res) => {
  res.send("Bot financeiro WhatsApp online com Gemini");
});

const PORT = process.env.PORT || 3000;

app.listen(PORT, () => {
  console.log(`Servidor rodando na porta ${PORT}`);
});