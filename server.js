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

const BASE44_API_URL = process.env.BASE44_API_URL;
const BASE44_API_KEY = process.env.BASE44_API_KEY;

const ai = new GoogleGenAI({
  apiKey: GEMINI_API_KEY
});

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

function normalizeText(text) {
  return String(text || "").trim();
}

function isLinkCode(text) {
  return /^SM-\d{6}$/i.test(text.trim());
}

function cleanJson(text) {
  return String(text || "")
    .replace(/```json/g, "")
    .replace(/```/g, "")
    .trim();
}

async function base44Request(method, path, data = null) {
  if (!BASE44_API_URL || !BASE44_API_KEY) {
    throw new Error("BASE44_API_URL ou BASE44_API_KEY não configurado.");
  }

  const response = await axios({
    method,
    url: `${BASE44_API_URL}${path}`,
    data,
    headers: {
      Authorization: `Bearer ${BASE44_API_KEY}`,
      "Content-Type": "application/json"
    }
  });

  return response.data;
}

async function findUserByWhatsAppNumber(whatsappNumber) {
  try {
    return await base44Request(
      "GET",
      `/api/whatsapp/user-by-number?whatsapp_number=${encodeURIComponent(whatsappNumber)}`
    );
  } catch (error) {
    console.log("Usuário não vinculado ou erro ao buscar usuário.");
    return null;
  }
}

async function linkWhatsAppCode(code, whatsappNumber) {
  return await base44Request("POST", "/api/whatsapp/link-code", {
    code,
    whatsapp_number: whatsappNumber
  });
}

async function createTransaction(userId, action) {
  return await base44Request("POST", "/api/transactions/from-whatsapp", {
    user_id: userId,
    source: "whatsapp",
    action
  });
}

async function queryFinance(userId, query) {
  return await base44Request("POST", "/api/finance/query-whatsapp", {
    user_id: userId,
    query
  });
}

function welcomeMessage(isLinked = false) {
  if (!isLinked) {
    return `Olá! 👋 Eu sou seu Assistente Financeiro IA.

Antes de lançar despesas, receitas ou consultar seus dados, preciso vincular seu WhatsApp à sua conta.

No app, vá em:
Configuração WhatsApp → Gerar código de vínculo

Depois envie aqui somente o código, por exemplo:

SM-123456

Depois de vincular, você poderá me mandar coisas como:

• Gastei 35 reais com lanche hoje
• Recebi 1500 de salário
• Quanto gastei esse mês?
• Quais contas vencem amanhã?`;
  }

  return `Olá! 👋 Seu WhatsApp já está vinculado.

Você pode me mandar:

• Gastei 35 reais com lanche hoje
• Recebi 1500 de salário
• Comprei uma TV de 3200 em 12x
• Quanto gastei esse mês?
• Qual meu saldo?
• Quais contas vencem amanhã?`;
}

async function interpretFinancialMessage(text, isLinked) {
  const prompt = `
Você é um assistente financeiro brasileiro para WhatsApp.

Interprete a mensagem abaixo e retorne SOMENTE JSON válido, sem markdown e sem explicações.

Mensagem:
"${text}"

Contexto:
- O usuário ${isLinked ? "já está vinculado ao sistema" : "ainda NÃO está vinculado ao sistema"}.
- Se o usuário não estiver vinculado e mandar saudação, explique que ele precisa enviar o código gerado no app.
- Código de vínculo tem formato SM-999999.
- Se a mensagem for apenas saudação, conversa comum, agradecimento ou pedido de ajuda, use action = "chat".
- Se for lançamento financeiro, use action = "create_transaction".
- Se for consulta financeira, use action = "query".
- Se for confirmação, use action = "confirm".
- Se for cancelamento, use action = "cancel".
- Se não entender, use action = "unknown".

Palavras de confirmação:
sim, confirmar, confirma, lançar, pode lançar, 1

Palavras de cancelamento:
cancelar, cancela, não, 2

Categorias sugeridas:
Alimentação, Mercado, Lazer, Saúde, Transporte, Combustível, Moradia, Salário, Renda Extra, Assinaturas, Investimentos, Dívidas, Outros.

Datas:
hoje = today
ontem = yesterday
amanhã = tomorrow
se não informar data em lançamento, use today

Status:
- gasto, gastei, paguei, comprei = paid
- recebi = received
- vencendo, a pagar, parcela futura = pending

Retorne um dos formatos abaixo.

Conversa normal:
{
  "action": "chat",
  "message": "mensagem natural para responder ao usuário"
}

Lançamento:
{
  "action": "create_transaction",
  "type": "expense | income | debt | investment | transfer",
  "description": "string",
  "category": "string",
  "amount": number,
  "date": "today | yesterday | tomorrow | null",
  "status": "paid | pending | received | null",
  "payment_method": null,
  "account": null,
  "card": null,
  "installments": null,
  "confidence": number
}

Consulta:
{
  "action": "query",
  "query_type": "balance | expenses_month | income_month | due_bills | summary | debts | unknown",
  "period": "today | current_month | next_month | current_week | null",
  "message": "resposta curta dizendo que vai consultar os dados",
  "confidence": number
}

Confirmação:
{
  "action": "confirm"
}

Cancelamento:
{
  "action": "cancel"
}

Desconhecido:
{
  "action": "unknown",
  "message": "mensagem amigável pedindo para o usuário explicar melhor"
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

function formatTransactionPreview(data) {
  const tipo =
    data.type === "expense" ? "Despesa" :
    data.type === "income" ? "Receita" :
    data.type === "debt" ? "Dívida" :
    data.type === "investment" ? "Investimento" :
    data.type === "transfer" ? "Transferência" :
    "Lançamento";

  const valor = Number(data.amount || 0).toLocaleString("pt-BR", {
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

Deseja lançar?
Responda:
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

    if (!message) {
      return res.sendStatus(200);
    }

    const from = message.from;

    if (message.type !== "text") {
      await sendWhatsAppMessage(
        from,
        "Recebi sua mensagem, mas por enquanto estou entendendo apenas texto. Em breve vou analisar imagens, comprovantes e áudios."
      );
      return res.sendStatus(200);
    }

    const text = normalizeText(message.text?.body);

    console.log(`Mensagem de ${from}: ${text}`);

    let linkedUser = await findUserByWhatsAppNumber(from);
    const isLinked = !!linkedUser?.user_id;

    if (isLinkCode(text)) {
      try {
        const result = await linkWhatsAppCode(text.toUpperCase(), from);

        await sendWhatsAppMessage(
          from,
          `✅ WhatsApp vinculado com sucesso!

Agora você pode lançar despesas, receitas e consultar suas informações financeiras por aqui.

Exemplos:
• Gastei 35 reais com lanche hoje
• Recebi 1500 de salário
• Quanto gastei esse mês?`
        );

        return res.sendStatus(200);
      } catch (error) {
        await sendWhatsAppMessage(
          from,
          `Não consegui vincular esse código.

Verifique se ele está correto e se ainda não expirou.

No app, gere um novo código em:
Configuração WhatsApp → Gerar código de vínculo`
        );

        return res.sendStatus(200);
      }
    }

    if (!isLinked) {
      const data = await interpretFinancialMessage(text, false);

      if (data.action === "chat") {
        await sendWhatsAppMessage(from, data.message || welcomeMessage(false));
        return res.sendStatus(200);
      }

      await sendWhatsAppMessage(from, welcomeMessage(false));
      return res.sendStatus(200);
    }

    if (pendingActions[from]) {
      const lowerText = text.toLowerCase();

      if (["1", "sim", "confirmar", "confirma", "lançar", "lancar", "pode lançar", "pode lancar"].includes(lowerText)) {
        const action = pendingActions[from];
        delete pendingActions[from];

        try {
          const result = await createTransaction(linkedUser.user_id, action);

          await sendWhatsAppMessage(
            from,
            `✅ Lançamento confirmado e salvo no sistema!

${result?.message || "Registro criado com sucesso."}`
          );
        } catch (error) {
          await sendWhatsAppMessage(
            from,
            `✅ Confirmei o lançamento, mas ainda não consegui salvar no Base44.

Provável motivo: endpoint do Base44 ainda não configurado.

Dados:
${JSON.stringify(action, null, 2)}`
          );
        }

        return res.sendStatus(200);
      }

      if (["2", "não", "nao", "cancelar", "cancela"].includes(lowerText)) {
        delete pendingActions[from];
        await sendWhatsAppMessage(from, "Lançamento cancelado.");
        return res.sendStatus(200);
      }
    }

    const data = await interpretFinancialMessage(text, true);

    if (data.action === "chat") {
      await sendWhatsAppMessage(from, data.message || welcomeMessage(true));
      return res.sendStatus(200);
    }

    if (data.action === "query") {
      try {
        const result = await queryFinance(linkedUser.user_id, data);

        await sendWhatsAppMessage(
          from,
          result?.message || "Consulta realizada."
        );
      } catch (error) {
        await sendWhatsAppMessage(
          from,
          `Entendi sua consulta, mas ainda não consegui buscar os dados no Base44.

Consulta: ${data.query_type || "não informada"}
Período: ${data.period || "não informado"}

Próxima etapa: configurar o endpoint de consultas no Base44.`
        );
      }

      return res.sendStatus(200);
    }

    if (data.action === "create_transaction" && data.amount) {
      pendingActions[from] = data;
      await sendWhatsAppMessage(from, formatTransactionPreview(data));
      return res.sendStatus(200);
    }

    if (data.action === "unknown") {
      await sendWhatsAppMessage(
        from,
        data.message || `Não entendi totalmente.

Você pode me enviar algo como:
• Gastei 35 reais com lanche hoje
• Recebi 1500 de salário
• Quanto gastei esse mês?`
      );

      return res.sendStatus(200);
    }

    await sendWhatsAppMessage(from, welcomeMessage(true));
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
          "⚠️ Tive um problema ao processar sua mensagem. Tente novamente em alguns instantes."
        );
      }
    } catch (sendError) {
      console.error(sendError.response?.data || sendError.message);
    }

    return res.sendStatus(200);
  }
});

app.get("/", (req, res) => {
  res.send("Bot financeiro WhatsApp online com Gemini e vínculo de usuários.");
});

const PORT = process.env.PORT || 3000;

app.listen(PORT, () => {
  console.log(`Servidor rodando na porta ${PORT}`);
});
