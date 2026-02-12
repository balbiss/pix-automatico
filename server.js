import 'dotenv/config';
import express from 'express';
import { Telegraf } from 'telegraf';
import { createClient } from '@supabase/supabase-js';
import axios from 'axios';

const VERSION = "V3.005";
const app = express();
app.use(express.json());

function log(tag, message) {
  const time = new Date().toLocaleTimeString('en-US', { hour12: false, hour: 'numeric', minute: '2-digit', second: '2-digit' });
  console.log(`[BOT LOG] [${VERSION}] ${time} - [${tag}] ${message}`);
}

const esc = (text) => {
  if (!text) return "";
  return String(text).replace(/[_*[\]()~`>#+\-=|{}.!]/g, '\\$&');
};

let config = {
  PRODUCT_PRICE: process.env.PRODUCT_PRICE || "19.90",
  COMMISSION_L1: process.env.COMMISSION_L1 || "6.00",
  COMMISSION_L2: process.env.COMMISSION_L2 || "3.00",
  ADMIN_ID: "7924857149"
};

const {
  SUPABASE_URL,
  SUPABASE_SERVICE_ROLE_KEY,
  TELEGRAM_BOT_TOKEN,
  SYNCPAY_CLIENT_ID,
  SYNCPAY_CLIENT_SECRET,
  SYNCPAY_BASE_URL,
  WEBHOOK_URL
} = process.env;

const supabase = createClient(SUPABASE_URL || 'http://localhost', SUPABASE_SERVICE_ROLE_KEY || 'key');
const bot = new Telegraf(TELEGRAM_BOT_TOKEN || '000:dummy');

log('SYSTEM', `Iniciando V3.005 com Modo Simulação...`);

// --- LOGICA REUTILIZÁVEL DE ENTREGA ---
async function processSuccessfulPayment(syncPayId, sourceTag = 'WEBHOOK') {
  try {
    log(sourceTag, `Processando ID: ${syncPayId}`);

    // 1. Mapeamento transação -> usuário
    const { data: pagamento } = await supabase.from('pagamentos').select('telegram_id').eq('id_transacao', syncPayId).single();

    if (!pagamento) {
      log(sourceTag, `Erro: ID ${syncPayId} não encontrado na tabela 'pagamentos'.`);
      return { success: false, error: 'ID não mapeado' };
    }

    const tid = pagamento.telegram_id;
    const { data: user } = await supabase.from('usuarios').select('*').eq('telegram_id', tid).single();

    if (!user) return { success: false, error: 'Usuário não existe' };
    if (user.is_active) return { success: true, warning: 'Já estava ativo' };

    // 2. Ativar usuário
    await supabase.from('usuarios').update({ is_active: true }).eq('telegram_id', tid);

    // 3. Comissões
    if (user.padrinho_id) {
      await supabase.rpc('increment_balance', { user_id: user.padrinho_id, amount: parseFloat(config.COMMISSION_L1) });
      if (user.avo_id) {
        await supabase.rpc('increment_balance', { user_id: user.avo_id, amount: parseFloat(config.COMMISSION_L2) });
      }
    }

    // 4. Notificar e entregar
    await bot.telegram.sendMessage(tid, `✅ *PAGAMENTO CONFIRMADO\\!*

Aproveite seu acesso exclusivo\\. O conteúdo está sendo enviado abaixo\\.`, { parse_mode: 'MarkdownV2' });

    await bot.telegram.sendDocument(tid, { source: './ebook.pdf' })
      .catch(() => log('ERROR', 'ebook.pdf não encontrado na raiz do projeto.'));

    log('SUCCESS', `User ${tid} liberado via ${sourceTag}`);
    return { success: true };
  } catch (e) {
    log('ERROR', `Erro processSuccessfulPayment: ${e.message}`);
    return { success: false, error: e.message };
  }
}

// --- LÓGICA SYNCPAY ---
async function getSyncPayToken() {
  const resp = await axios.post(`${SYNCPAY_BASE_URL}/api/partner/v1/auth-token`, { client_id: SYNCPAY_CLIENT_ID, client_secret: SYNCPAY_CLIENT_SECRET });
  return resp.data.access_token;
}

async function createSyncPayCharge(telegramId, amount) {
  const token = await getSyncPayToken();
  const payload = {
    external_id: `TX_${telegramId}_${Date.now()}`,
    amount: parseFloat(amount),
    description: `Pedido ${telegramId}`,
    webhook_url: WEBHOOK_URL,
    client: { name: "C. Final", cpf: "12345678909", email: "pagamento@botindicacao.com" }
  };
  const response = await axios.post(`${SYNCPAY_BASE_URL}/api/partner/v1/cash-in`, payload, { headers: { Authorization: `Bearer ${token}` } });
  const data = response.data.data || response.data;
  const syncPayId = data.idtransaction || data.id;

  await supabase.from('pagamentos').insert([{ id_transacao: syncPayId, telegram_id: telegramId, status: 'pending' }])
    .catch(e => log('WARN', 'Salve o SQL da tabela "pagamentos" no Supabase!'));

  return data;
}

// --- WEBHOOK ---
app.all('/webhook/syncpay', async (req, res) => {
  log('WEBHOOK_IN', JSON.stringify(req.body));
  const bodyData = req.body.data || req.body;
  const { idtransaction, id, status, external_id } = bodyData;
  const syncPayId = idtransaction || id;

  if (['PAID', 'completed', 'success', 'PAID_OUT'].includes(status)) {
    await processSuccessfulPayment(syncPayId, 'WEBHOOK');
  }
  res.send('ACK');
});

// --- TELEGRAM BOT ---
bot.start(async (ctx) => {
  const tid = ctx.from.id.toString();
  const { data: user } = await supabase.from('usuarios').select('*').eq('telegram_id', tid).single();
  if (!user) {
    const sp = ctx.startPayload;
    let p1 = null, p2 = null;
    if (sp && sp !== tid) {
      const { data: p } = await supabase.from('usuarios').select('telegram_id, padrinho_id').eq('telegram_id', sp).single();
      if (p) { p1 = p.telegram_id; p2 = p.padrinho_id; }
    }
    await supabase.from('usuarios').insert([{ telegram_id: tid, padrinho_id: p1, avo_id: p2, saldo: 0, is_active: false }]);
  }
  const msg = `🚀 *BEM\\-VINDO AO IMPÉRIO DIGITAL\\!*

Sua liberdade financeira começa aqui\\! Adquira o e\\-book premium ou use seu link para ganhar comissões\\.

 Escolha uma opção:`;
  ctx.replyWithMarkdownV2(msg, {
    reply_markup: {
      inline_keyboard: [[{ text: "💳 COMPRAR AGORA", callback_data: "buy_pix" }], [{ text: "📊 MEU PAINEL", callback_data: "profile" }]]
    }
  });
});

bot.action('buy_pix', async (ctx) => {
  try {
    await ctx.answerCbQuery("Gerando Pix...");
    const charge = await createSyncPayCharge(ctx.from.id.toString(), config.PRODUCT_PRICE);
    const pixCode = charge.pix_code || charge.pix_copy_and_paste || charge.paymentcode;
    const syncPayId = charge.idtransaction || charge.id;

    const msg = `⚡ *PAGAMENTO PIX*
      
\`${esc(pixCode)}\`

_A entrega é automática após pagar\\._

*ID DA TRANSAÇÃO:*
\`${esc(syncPayId)}\``;

    await ctx.editMessageText(msg, {
      parse_mode: 'MarkdownV2',
      reply_markup: { inline_keyboard: [[{ text: "⬅️ VOLTAR", callback_data: "back_to_start" }]] }
    });
  } catch (e) { ctx.reply("❌ Falha SyncPay."); }
});

bot.action('profile', async (ctx) => {
  const tid = ctx.from.id.toString();
  const { data: u } = await supabase.from('usuarios').select('*').eq('telegram_id', tid).single();
  const { count: n1 } = await supabase.from('usuarios').select('*', { count: 'exact', head: true }).eq('padrinho_id', tid);
  const { count: n2 } = await supabase.from('usuarios').select('*', { count: 'exact', head: true }).eq('avo_id', tid);
  const me = await bot.telegram.getMe();
  const DASH = `👤 *MEU PAINEL*
  
💰 *Saldo:* R$ ${esc(u.saldo.toFixed(2))}
👥 *Rede:* L1: ${esc(n1 || 0)} | L2: ${esc(n2 || 0)}

🔗 *SEU LINK:*
\`https://t.me/${me.username}?start=${tid}\``;
  await ctx.editMessageText(DASH, {
    parse_mode: 'MarkdownV2',
    reply_markup: {
      inline_keyboard: [[{ text: "💸 SACAR", callback_data: "withdraw" }], [{ text: "⬅️ VOLTAR", callback_data: "back_to_start" }]]
    }
  });
});

bot.action('back_to_start', async (ctx) => {
  const tid = ctx.from.id.toString();
  const msg = `🚀 *BEM\\-VINDO AO IMPÉRIO DIGITAL\\!*
Escolha uma opção:`;
  await ctx.editMessageText(msg, {
    parse_mode: 'MarkdownV2',
    reply_markup: {
      inline_keyboard: [[{ text: "💳 COMPRAR AGORA", callback_data: "buy_pix" }], [{ text: "📊 MEU PAINEL", callback_data: "profile" }]]
    }
  }).catch(() => ctx.answerCbQuery());
});

// --- ADMIN & SIMULAÇÃO ---
bot.command('admin', (ctx) => {
  if (ctx.from.id.toString() !== config.ADMIN_ID) return;
  ctx.reply(`⚙️ ADMIN V3.005
/testar ID_TRANSACAO - Simula sucesso p/ testar entrega e comissão free.`);
});

bot.command('testar', async (ctx) => {
  if (ctx.from.id.toString() !== config.ADMIN_ID) return;
  const syncPayId = ctx.message.text.split(' ')[1];
  if (!syncPayId) return ctx.reply("❌ Use: /testar ID_DA_TRANSACAO");

  ctx.reply(`🛠️ Simulando sucesso para transação ${syncPayId}...`);
  const result = await processSuccessfulPayment(syncPayId, 'SIMULATION');

  if (result.success) {
    ctx.reply("✅ Simulação concluída! Verifique se recebeu o PDF e se o saldo atualizou.");
  } else {
    ctx.reply(`❌ Erro: ${result.error}`);
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, '0.0.0.0', async () => {
  log('SYSTEM', `V3.005 Online na porta ${PORT}`);
  try { await bot.launch(); } catch (e) { log('ERROR', e.message); }
});
