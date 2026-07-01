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

const BASE44_API_URL = process.env.BASE44_API_URL || "https://app.base44.com/api";
const BASE44_APP_ID = process.env.BASE44_APP_ID;
const BASE44_API_KEY = process.env.BASE44_API_KEY;

const ENTITY_WHATSAPP_LINKS = "WhatsAppUserLink";
const ENTITY_WHATSAPP_MESSAGES = "WhatsAppMessage";

const ai = new GoogleGenAI({
  apiKey: GEMINI_API_KEY
});

const pendingActions = {};

function getBase44Root() {
  let root = String(BASE44_API_URL || "").replace(/\/$/, "");

  if (root.endsWith("/api") && BASE44_APP_ID) {
    root = `${root}/apps/${BASE44_APP_ID}`;
  }

  return root;
}

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

async function base44Request(method, path, data = null, params = null) {
  if (!BASE44_API_KEY) {
    throw new Error("BASE44_API_KEY não configurada.");
  }

  const response = await axios({
    method,
    url: `${getBase44Root()}${path}`,
    data,
    params,
    headers: {
      api_key: BASE44_API_KEY,
      "Content-Type": "application/json"
    }
  });

  return response.data;
}

async function listEntity(entityName) {
  const result = await base44Request("GET", `/entities/${entityName}`);

  if (Array.isArray(result)) return result;
  if (Array.isArray(result.data)) return result.data;
  if (Array.isArray(result.items)) return result.items;
  if (Array.isArray(result.records)) return result.records;

  console.log("Retorno inesperado do Base44:", JSON.stringify(result, null, 2));
  return [];
}

async function createEntity(entityName, data) {
  return await base44Request("POST", `/entities/${entityName}`, data);
}

async function updateEntity(entityName, id, data) {
  return await base44Request("PUT", `/entities/${entityName}/${id}`, data);
}

function normalizeText(text) {
  return String(text || "").trim();
}

function normalizePhone(phone) {
  return String(phone || "").replace(/\D/g, "");
}

function isLinkCode(text) {
  return /^SM-[A-Z0-9]{6}$/i.test(String(text || "").trim());
}

function cleanJson(text) {
  return String(text || "")
    .replace(/```json/g, "")
    .replace(/```/g, "")
    .trim();
}

function getUserIdFromLink(link) {
  return (
    link.user_id ||
    link.userId ||
    link.user?.id ||
    link.user ||
    link.created_by ||
    link.created_by_id ||
    null
  );
}

function getLinkCode(link) {
  return String(link.code || link.codigo || "").toUpperCase();
}

function getLinkStatus(link) {
  return String(link.status || "").toLowerCase();
}

async function findUserByWhatsAppNumber(whatsappNumber) {
  try {
    const cleanNumber = normalizePhone(whatsappNumber);
    const records = await listEntity(ENTITY_WHATSAPP_LINKS);

    const found = records.find((item) => {
      const itemNumber = normalizePhone(
        item.whatsapp_number ||
        item.phone ||
        item.telefone ||
        item.number ||
        ""
      );

      const status = getLinkStatus(item);

      return (
        itemNumber === cleanNumber &&
        (status === "linked" || status === "vinculado" || item.active === true)
      );
    });

    if (!found) {
      console.log("Usuário não vinculado ou erro ao buscar usuário.");
      return null;
    }

    return {
      ...found,
      user_id: getUserIdFromLink(found)
    };
  } catch (error) {
    console.log("Erro ao buscar vínculo:", error.response?.data || error.message);
    return null;
  }
}

async function linkWhatsAppCode(code, whatsappNumber) {
  const cleanCode = code.toUpperCase();
  const cleanNumber = normalizePhone(whatsappNumber);

  const records = await listEntity(ENTITY_WHATSAPP_LINKS);

  console.log("Registros WhatsAppUserLink:");
  console.log(JSON.stringify(records, null, 2));

  const link = records.find((item) => {
    const status = getLinkStatus(item);

    return (
      getLinkCode(item) === cleanCode &&
      (status === "pending" || status === "pendente")
    );
  });

  if (!link) {
    throw new Error("Código inválido, expirado ou já utilizado.");
  }

  if (link.expires_at && new Date(link.expires_at) < new Date()) {
    await updateEntity(ENTITY_WHATSAPP_LINKS, link.id, {
      status: "expired",
      active: false
    });

    throw new Error("Código expirado.");
  }

  const alreadyLinked = records.filter((item) => {
    const itemNumber = normalizePhone(
      item.whatsapp_number ||
      item.phone ||
      item.telefone ||
      item.number ||
      ""
    );

    const status = getLinkStatus(item);

    return (
      itemNumber === cleanNumber &&
      (status === "linked" || status === "vinculado" || item.active === true)
    );
  });

  for (const item of alreadyLinked) {
    await updateEntity(ENTITY_WHATSAPP_LINKS, item.id, {
      status: "cancelled",
      active: false
    });
  }

  const updated = await updateEntity(ENTITY_WHATSAPP_LINKS, link.id, {
    whatsapp_number: cleanNumber,
    phone: cleanNumber,
    telefone: cleanNumber,
    status: "linked",
    active: true,
    linked_at: new Date().toISOString()
  });

  return {
    ...updated,
    user_id: getUserIdFromLink(updated) || getUserIdFromLink(link)
  };
}

async function saveMessageLog({
  userId,
  whatsappNumber,
  messageText,
  responseText,
  actionJson,
  status
}) {
  try {
    if (messageText) {
      await createEntity(ENTITY_WHATSAPP_MESSAGES, {
        user_id: userId || null,
        whatsapp_number: normalizePhone(whatsappNumber),

        content: messageText,
        direction: "incoming",

        message_text: messageText || "",
        response_text: "",
        action_json: actionJson ? JSON.stringify(actionJson) : "",
        status: status || "processed",
        created_at: new Date().toISOString()
      });
    }

    if (responseText) {
      await createEntity(ENTITY_WHATSAPP_MESSAGES, {
        user_id: userId || null,
        whatsapp_number: normalizePhone(whatsappNumber),

        content: responseText,
        direction: "outgoing",

        message_text: "",
        response_text: responseText || "",
        action_json: actionJson ? JSON.stringify(actionJson) : "",
        status: status || "processed",
        created_at: new Date().toISOString()
      });
    }
  } catch (error) {
    console.log("Não foi possível salvar histórico:", error.response?.data || error.message);
  }
}

function toIsoDate(dateValue) {
  const now = new Date();

  if (dateValue === "yesterday") now.setDate(now.getDate() - 1);
  if (dateValue === "tomorrow") now.setDate(now.getDate() + 1);

  return now.toISOString().slice(0, 10);
}

async function createTransaction(userId, action) {
  const entityByType = {
    expense: "Expense",
    income: "Income",
    debt: "Debt",
    investment: "Investment"
  };

  const entityName = entityByType[action.type];

  if (!entityName) {
    throw new Error(`Tipo não suportado: ${action.type}`);
  }

  const payload = {
    user_id: userId,
    user: userId,
    source: "whatsapp",
    description: action.description || action.category || "Lançamento WhatsApp",
    category: action.category || "Outros",
    amount: Number(action.amount),
    date: toIsoDate(action.date),
    status: action.status || "paid",
    payment_method: action.payment_method || null,
    account: action.account || null,
    card: action.card || null,
    installments: action.installments || null,
    notes: action.notes || "",
    created_at: new Date().toISOString()
  };

  if (entityName === "Expense") {
    return await createEntity("Expense", {
      ...payload,
      paid: action.status === "paid"
    });
  }

  if (entityName === "Income") {
    return await createEntity("Income", {
      ...payload,
      received: action.status === "received"
    });
  }

  if (entityName === "Debt") {
    return await createEntity("Debt", {
      ...payload,
      original_amount: Number(action.amount),
      remaining_amount: Number(action.amount),
      monthly_interest: action.monthly_interest || 0
    });
  }

  if (entityName === "Investment") {
    return await createEntity("Investment", {
      ...payload,
      initial_amount: Number(action.amount),
      current_value: Number(action.amount)
    });
  }
}

function formatMoney(value) {
  return Number(value || 0).toLocaleString("pt-BR", {
    style: "currency",
    currency: "BRL"
  });
}

function getDebtMonthlyAmount(item) {
  return Number(item.installment_amount || 0);
}

function getAmount(item) {
  return Number(
    item.amount ??
    item.value ??
    item.valor ??
    item.current_value ??
    item.total_amount ??
    0
  );
}

function getDateValue(item) {
  return item.date || item.due_date || item.created_at || item.created_date || null;
}

function isCurrentMonth(dateValue) {
  if (!dateValue) return false;

  const date = new Date(dateValue);
  const now = new Date();

  return (
    date.getFullYear() === now.getFullYear() &&
    date.getMonth() === now.getMonth()
  );
}

function isSameUser(item, linkedUser) {
  const possibleUserIds = [
    linkedUser.user_id,
    linkedUser.user,
    linkedUser.created_by,
    linkedUser.created_by_id
  ].filter(Boolean).map(String);

  const itemUsers = [
    item.user_id,
    item.user,
    item.created_by,
    item.created_by_id,
    item.owner_id
  ].filter(Boolean).map(String);

  return itemUsers.some((u) => possibleUserIds.includes(u));
}

async function safeListEntity(entityName) {
  try {
    return await listEntity(entityName);
  } catch (error) {
    console.log(`Erro ao listar ${entityName}:`, error.response?.data || error.message);
    return [];
  }
}

async function handleFinanceQuery(linkedUser, data) {
  const [incomesRaw, expensesRaw, debtsRaw, investmentsRaw, goalsRaw, subscriptionsRaw] =
    await Promise.all([
      safeListEntity("Income"),
      safeListEntity("Expense"),
      safeListEntity("Debt"),
      safeListEntity("Investment"),
      safeListEntity("Goal"),
      safeListEntity("Subscription")
    ]);

  const incomes = incomesRaw.filter((item) => isSameUser(item, linkedUser));
  const expenses = expensesRaw.filter((item) => isSameUser(item, linkedUser));
  const debts = debtsRaw.filter((item) => isSameUser(item, linkedUser));
  const investments = investmentsRaw.filter((item) => isSameUser(item, linkedUser));
  const goals = goalsRaw.filter((item) => isSameUser(item, linkedUser));
  const subscriptions = subscriptionsRaw.filter((item) => isSameUser(item, linkedUser));

  const incomesMonth = incomes.filter((item) => isCurrentMonth(getDateValue(item)));
  const expensesMonth = expenses.filter((item) => isCurrentMonth(getDateValue(item)));

  const totalIncomeMonth = incomesMonth.reduce((sum, item) => sum + getAmount(item), 0);
  const totalExpenseMonth = expensesMonth.reduce((sum, item) => sum + getAmount(item), 0);
  const debtsMonth = debts.filter((item) => isCurrentMonth(getDateValue(item)));

  const activeDebts = debts.filter((item) => {
    const status = String(item.status || "").toLowerCase();
    return item.active === true || status === "active" || status === "ativa" || status === "";
  });
  const now = new Date();

const totalDebtMonth = activeDebts.reduce((sum, item) => {
  const currentInstallment = Number(item.current_installment || 0);
  const totalInstallments = Number(item.installments_count || 0);

  if (totalInstallments > 0 && currentInstallment > totalInstallments) {
    return sum;
  }

  const installmentAmount = Number(item.installment_amount || 0);

  console.log("DÍVIDA CALCULADA:", {
    name: item.name,
    total_amount: item.total_amount,
    installments_count: item.installments_count,
    current_installment: item.current_installment,
    installment_amount: item.installment_amount,
    usado_no_mes: installmentAmount
  });

  return sum + installmentAmount;
}, 0);
  const totalDebtOpen = debts.reduce(
    (sum, item) => sum + Number(item.total_amount || 0),
    0
  );
  const totalInvested = investments.reduce((sum, item) => sum + getAmount(item), 0);
  const totalSubscriptions = subscriptions.reduce((sum, item) => sum + getAmount(item), 0);

  const totalCommittedMonth =
    totalExpenseMonth + totalSubscriptions + totalDebtMonth;

  const balance = totalIncomeMonth - totalCommittedMonth;
  

  if (data.query_type === "balance") {
    return `📊 Seu saldo estimado deste mês:

Receitas: ${formatMoney(totalIncomeMonth)}

Despesas lançadas: ${formatMoney(totalExpenseMonth)}
Assinaturas: ${formatMoney(totalSubscriptions)}
Dívidas/parcelas do mês: ${formatMoney(totalDebtMonth)}

Total comprometido: ${formatMoney(totalCommittedMonth)}

Saldo disponível: ${formatMoney(balance)}

Investido: ${formatMoney(totalInvested)}
Dívidas em aberto: ${formatMoney(totalDebtOpen)}`;
  }

  if (data.query_type === "expenses_month") {
    return `💸 Suas despesas deste mês:

Total: ${formatMoney(totalExpenseMonth)}
Quantidade: ${expensesMonth.length} lançamento(s)

Maiores despesas:
${expensesMonth
  .sort((a, b) => getAmount(b) - getAmount(a))
  .slice(0, 5)
  .map((item) => `• ${item.description || item.name || "Despesa"}: ${formatMoney(getAmount(item))}`)
  .join("\n") || "Nenhuma despesa encontrada."}`;
  }

  if (data.query_type === "income_month") {
    return `💰 Suas receitas deste mês:

Total: ${formatMoney(totalIncomeMonth)}
Quantidade: ${incomesMonth.length} lançamento(s)

Receitas:
${incomesMonth
  .slice(0, 5)
  .map((item) => `• ${item.description || item.name || "Receita"}: ${formatMoney(getAmount(item))}`)
  .join("\n") || "Nenhuma receita encontrada."}`;
  }

  if (data.query_type === "debts") {
    return `📌 Suas dívidas:

Total em aberto: ${formatMoney(totalDebtOpen)}
Quantidade: ${debts.length}

${debts
  .slice(0, 5)
  .map((item) => `• ${item.description || item.name || "Dívida"}: ${formatMoney(getAmount(item))}`)
  .join("\n") || "Nenhuma dívida encontrada."}`;
  }

  if (data.query_type === "investments") {
    return `📈 Seus investimentos:

Total investido: ${formatMoney(totalInvested)}
Quantidade: ${investments.length}

${investments
  .slice(0, 5)
  .map((item) => `• ${item.description || item.name || "Investimento"}: ${formatMoney(getAmount(item))}`)
  .join("\n") || "Nenhum investimento encontrado."}`;
  }

  if (data.query_type === "goals") {
    return `🎯 Suas metas:

Quantidade: ${goals.length}

${goals
  .slice(0, 5)
  .map((item) => `• ${item.name || item.description || "Meta"}: ${formatMoney(getAmount(item))}`)
  .join("\n") || "Nenhuma meta encontrada."}`;
  }

  if (data.query_type === "due_bills") {
    return `📅 Próximas contas/assinaturas:

Dívidas:
${debts.slice(0, 5).map((item) => `• ${item.description || item.name || "Dívida"}: ${formatMoney(getAmount(item))}`).join("\n") || "Nenhuma dívida encontrada."}

Assinaturas:
${subscriptions.slice(0, 5).map((item) => `• ${item.name || "Assinatura"}: ${formatMoney(getAmount(item))}`).join("\n") || "Nenhuma assinatura encontrada."}`;
  }

  return `📊 Resumo financeiro deste mês:

Receitas: ${formatMoney(totalIncomeMonth)}
Despesas: ${formatMoney(totalExpenseMonth)}
Saldo: ${formatMoney(balance)}
Investimentos: ${formatMoney(totalInvested)}
Dívidas: ${formatMoney(totalDebtOpen)}
Assinaturas: ${formatMoney(totalSubscriptions)}`;
}

function welcomeMessage(isLinked = false) {
  if (!isLinked) {
    return `Olá! 👋 Eu sou seu Assistente Financeiro IA.

Antes de lançar despesas, receitas ou consultar seus dados, preciso vincular seu WhatsApp à sua conta.

No app, vá em:

Configuração WhatsApp → Gerar código de vínculo

Depois envie aqui somente o código, por exemplo:

SM-123456

Depois disso você poderá me mandar:

• Gastei 35 reais com lanche hoje
• Recebi 1500 de salário
• Quanto gastei esse mês?
• Quais contas vencem amanhã?`;
  }

  return `Olá! 👋 Seu WhatsApp já está vinculado.

Você pode me mandar naturalmente:

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

Retorne SOMENTE JSON válido, sem markdown.

Mensagem:
"${text}"

Contexto:
O usuário ${isLinked ? "já está vinculado" : "ainda não está vinculado"}.

Regras:
- Saudação ou conversa normal: action = "chat".
- Lançamento financeiro: action = "create_transaction".
- Consulta financeira: action = "query".
- Confirmação: action = "confirm".
- Cancelamento: action = "cancel".
- Se não entender: action = "unknown".

Categorias:
Alimentação, Mercado, Lazer, Saúde, Transporte, Combustível, Moradia, Salário, Renda Extra, Assinaturas, Investimentos, Dívidas, Outros.

Tipos:
- gasto, gastei, comprei, paguei = expense.
- recebi, salário, pagamento recebido, freela recebido = income.
- empréstimo, financiamento, dívida = debt.
- investi, apliquei, CDB, poupança, ações, cripto = investment.

Datas:
hoje = today
ontem = yesterday
amanhã = tomorrow
se não informar, use today.

Status:
gastei, paguei, comprei = paid
recebi = received
a pagar, vencendo, futura = pending

Conversa:
{
  "action": "chat",
  "message": "resposta natural"
}

Lançamento:
{
  "action": "create_transaction",
  "type": "expense | income | debt | investment",
  "description": "string",
  "category": "string",
  "amount": number,
  "date": "today | yesterday | tomorrow | null",
  "status": "paid | pending | received | null",
  "payment_method": null,
  "account": null,
  "card": null,
  "installments": null,
  "monthly_interest": null,
  "notes": null,
  "confidence": number
}

Consulta:
{
  "action": "query",
  "query_type": "balance | expenses_month | income_month | due_bills | summary | debts | investments | goals | unknown",
  "period": "today | current_month | next_month | current_week | null",
  "message": "resposta curta",
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
  "message": "mensagem amigável"
}
`;

  const response = await ai.models.generateContent({
    model: "gemini-2.5-flash",
    contents: prompt,
    config: {
      responseMimeType: "application/json"
    }
  });

  return JSON.parse(cleanJson(response.text || ""));
}

function formatTransactionPreview(data) {
  const tipo =
    data.type === "expense" ? "Despesa" :
    data.type === "income" ? "Receita" :
    data.type === "debt" ? "Dívida" :
    data.type === "investment" ? "Investimento" :
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

    if (!message) return res.sendStatus(200);

    const from = message.from;

    if (message.type !== "text") {
      await sendWhatsAppMessage(
        from,
        "Recebi sua mensagem, mas por enquanto estou entendendo apenas texto. Em breve vou analisar comprovantes, imagens e áudios."
      );

      return res.sendStatus(200);
    }

    const text = normalizeText(message.text?.body);
    console.log(`Mensagem de ${from}: ${text}`);

    const linkedUser = await findUserByWhatsAppNumber(from);
    const isLinked = !!linkedUser?.user_id;

    if (isLinkCode(text)) {
      try {
        const result = await linkWhatsAppCode(text, from);

        const responseText = `✅ WhatsApp vinculado com sucesso!

Agora você pode lançar despesas, receitas e consultar suas informações financeiras por aqui.

Exemplos:

• Gastei 35 reais com lanche hoje
• Recebi 1500 de salário
• Quanto gastei esse mês?`;

        await sendWhatsAppMessage(from, responseText);

        await saveMessageLog({
          userId: result.user_id,
          whatsappNumber: from,
          messageText: text,
          responseText,
          actionJson: result,
          status: "linked"
        });

        return res.sendStatus(200);
      } catch (error) {
        console.error("Erro ao vincular:", error.response?.data || error.message);

        const responseText = `Não consegui vincular esse código.

Verifique se ele está correto e se ainda não expirou.

No app, gere um novo código em:

Configuração WhatsApp → Gerar código de vínculo`;

        await sendWhatsAppMessage(from, responseText);
        return res.sendStatus(200);
      }
    }

    if (!isLinked) {
      const responseText = welcomeMessage(false);

      await sendWhatsAppMessage(from, responseText);

      await saveMessageLog({
        userId: null,
        whatsappNumber: from,
        messageText: text,
        responseText,
        status: "not_linked"
      });

      return res.sendStatus(200);
    }

    if (pendingActions[from]) {
      const lowerText = text.toLowerCase();

      if (["1", "sim", "confirmar", "confirma", "lançar", "lancar", "pode lançar", "pode lancar"].includes(lowerText)) {
        const action = pendingActions[from];
        delete pendingActions[from];

        try {
          const saved = await createTransaction(linkedUser.user_id, action);

          const responseText = `✅ Lançamento salvo com sucesso!

Descrição: ${action.description}
Valor: ${Number(action.amount).toLocaleString("pt-BR", {
            style: "currency",
            currency: "BRL"
          })}`;

          await sendWhatsAppMessage(from, responseText);

          await saveMessageLog({
            userId: linkedUser.user_id,
            whatsappNumber: from,
            messageText: text,
            responseText,
            actionJson: saved,
            status: "transaction_created"
          });
        } catch (error) {
          console.error("Erro ao salvar lançamento:", error.response?.data || error.message);

          await sendWhatsAppMessage(
            from,
            `Confirmei, mas não consegui salvar no Base44.

Erro:
${error.response?.data?.message || error.message}`
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
      const responseText = data.message || welcomeMessage(true);

      await sendWhatsAppMessage(from, responseText);

      await saveMessageLog({
        userId: linkedUser.user_id,
        whatsappNumber: from,
        messageText: text,
        responseText,
        actionJson: data,
        status: "chat"
      });

      return res.sendStatus(200);
    }

    if (data.action === "query") {
      const responseText = await handleFinanceQuery(linkedUser, data);

      await sendWhatsAppMessage(from, responseText);

      await saveMessageLog({
        userId: linkedUser.user_id,
        whatsappNumber: from,
        messageText: text,
        responseText,
        actionJson: data,
        status: "query_executed"
      });

      return res.sendStatus(200);
    }

    if (data.action === "create_transaction" && data.amount) {
      pendingActions[from] = data;

      const responseText = formatTransactionPreview(data);

      await sendWhatsAppMessage(from, responseText);

      await saveMessageLog({
        userId: linkedUser.user_id,
        whatsappNumber: from,
        messageText: text,
        responseText,
        actionJson: data,
        status: "pending_confirmation"
      });

      return res.sendStatus(200);
    }

    await sendWhatsAppMessage(
      from,
      data.message ||
      `Não entendi totalmente.

Você pode me mandar, por exemplo:

• Gastei 35 reais com lanche hoje
• Recebi 1500 de salário
• Quanto gastei esse mês?`
    );

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
  res.send("Bot financeiro WhatsApp online com Gemini, Base44 e vínculo de usuários.");
});

const PORT = process.env.PORT || 3000;

app.listen(PORT, () => {
  console.log(`Servidor rodando na porta ${PORT}`);
});
