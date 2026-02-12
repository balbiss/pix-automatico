import 'dotenv/config';
import express from 'express';
import { Telegraf } from 'telegraf';
import { createClient } from '@supabase/supabase-js';
import axios from 'axios';

const VERSION = "V3.004";
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

log('SYSTEM', `Iniciando Mapeamento V3.004 - Fix Entrega...`);

async function getSyncPayToken() {
  try {
    const response = await axios.post(`${SYNCPAY_BASE_URL}/api/partner/v1/auth-token`, {
      client_id: SYNCPAY_CLIENT_ID,
      client_secret: SYNCPAY_CLIENT_SECRET
    });
    return response.data.access_token;
  } catch (error) { throw error; }
}

async function createSyncPayCharge(telegramId, amount) {
  const token = await getSyncPayToken();
  const txId = `TX_${telegramId}_${Date.now()}`;
  try {
    const payload = {
      external_id: txId,
      amount: parseFloat(amount),
      description: `Premium - ${telegramId}`,
      webhook_url: WEBHOOK_URL,
      client: { name: "C. Final", cpf: "12345678909", email: "pagamento@botindicacao.com" }
    };
    const response = await axios.post(`${SYNCPAY_BASE_URL}/api/partner/v1/cash-in`, payload, {
      headers: { Authorization: `Bearer ${token}` }
    });

    const data = response.data.data || response.data;
    const syncPayId = data.idtransaction || data.id;

    // --- SALVAR RELAÇÃO NO BANCO ---
    // Tentamos salvar na tabela 'usuarios' ou numa tabela de logs se existir.
    // Para ser imediato sem novos schemas, vamos salvar no campo 'last_checkout_id'
    // que o usuário deve adicionar ou simplesmente ignorar erros se a tabela não existir.
    log('DEBUG', `Transação Gerada: ${syncPayId} para User: ${telegramId}`);

    // Fallback: Vamos tentar salvar na tabela 'pagamentos'. 
    // Se você não criou a tabela, ele vai dar erro no LOG, mas o QR Code aparece.
    await supabase.from('pagamentos').insert([{ id_transacao: syncPayId, telegram_id: telegramId, status: 'pending' }])
      .catch(e => log('WARN', 'Tabela "pagamentos" ausente. Rode o SQL no Supabase.'));

    return data;
  } catch (error) { throw error; }
}

app.all('/webhook/syncpay', async (req, res) => {
  log('WEBHOOK_IN', `Recebido: ${JSON.stringify(req.body)}`);

  // O corpo da SyncPay vem dentro de .data na V3.002 logs
  const bodyData = req.body.data || req.body;
  const { idtransaction, id, status, external_id, externalreference } = bodyData;
  const syncPayId = idtransaction || id;

  if (['PAID', 'completed', 'success', 'PAID_OUT'].includes(status)) {
    try {
      log('PROCESS', `Buscando dono da transação: ${syncPayId}`);

      // 1. Tenta buscar na tabela de pagamentos
      const { data: pagamento } = await supabase.from('pagamentos').select('telegram_id').eq('id_transacao', syncPayId).single();

      let telegramId = pagamento?.telegram_id;

      // 2. Se não achou na tabela, tenta o fallback pelo external_id (se vier)
      if (!telegramId) {
        telegramId = (external_id || externalreference)?.includes('_') ? (external_id || externalreference).split('_')[1] : null;
      }

      if (!telegramId) {
        log('ERROR', `Incapaz de identificar o usuário para a transação ${syncPayId}`);
        return res.send('User Not Found');
      }

      const { data: user } = await supabase.from('usuarios').select('*').eq('telegram_id', telegramId).single();
      if (!user || user.is_active) return res.send('OK');

      await supabase.from('usuarios').update({ is_active: true }).eq('telegram_id', telegramId);

      if (user.padrinho_id) {
        await supabase.rpc('increment_balance', { user_id: user.padrinho_id, amount: parseFloat(config.COMMISSION_L1) });
        if (user.avo_id) {
          await supabase.rpc('increment_balance', { user_id: user.avo_id, amount: parseFloat(config.COMMISSION_L2) });
        }
      }

      await bot.telegram.sendMessage(telegramId, `💎 *PAGAMENTO CONFIRMADO\\!*
      
Seu acesso foi liberado\\! Enviando conteúdo\\.\\.\\.`, { parse_mode: 'MarkdownV2' });

      await bot.telegram.sendDocument(telegramId, { source: './ebook.pdf' }).catch(() => log('ERROR', 'PDF ebook.pdf não encontrado no servidor.'));

      return res.send('OK');
    } catch (err) { log('ERROR', `Erro Webhook: ${err.message}`); }
  }
  res.send('Processando');
});

bot.start(async (ctx) => {
  const tid = ctx.from.id.toString();
  try {
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
    const menu = getStartMenu();
    ctx.replyWithMarkdownV2(menu.text, { reply_markup: menu.keyboard });
  } catch (e) { log('ERROR', 'Erro Start'); }
});

const getStartMenu = () => ({
  text: `🚀 *BEM\\-VINDO AO IMPÉRIO DIGITAL\\!*

💰 *E\\-book:* R$ ${esc(config.PRODUCT_PRICE)}
💎 *Ganhos:* Comissões em 2 níveis\\!

Escolha uma opção:`,
  keyboard: {
    inline_keyboard: [[{ text: "💳 COMPRAR AGORA", callback_data: "buy_pix" }], [{ text: "📊 MEU PAINEL", callback_data: "profile" }]]
  }
});

bot.action('back_to_start', async (ctx) => {
  const menu = getStartMenu();
  await ctx.editMessageText(menu.text, { parse_mode: 'MarkdownV2', reply_markup: menu.keyboard }).catch(() => ctx.answerCbQuery());
});

bot.action('buy_pix', async (ctx) => {
  try {
    await ctx.answerCbQuery("Gerando...");
    const charge = await createSyncPayCharge(ctx.from.id.toString(), config.PRODUCT_PRICE);
    const pixCode = charge.pix_code || charge.pix_copy_and_paste || charge.qrcode || charge.paymentcode;
    const msg = `⚡ *PAGAMENTO PIX*
      
\`${esc(pixCode)}\`

_Entrega automática após pagar\\._`;
    await ctx.editMessageText(msg, {
      parse_mode: 'MarkdownV2',
      reply_markup: { inline_keyboard: [[{ text: "⬅️ VOLTAR", callback_data: "back_to_start" }]] }
    });
  } catch (e) { ctx.reply("❌ Erro ao gerar Pix."); }
});

bot.action('profile', async (ctx) => {
  const tid = ctx.from.id.toString();
  try {
    const { data: u } = await supabase.from('usuarios').select('*').eq('telegram_id', tid).single();
    const { count: n1 } = await supabase.from('usuarios').select('*', { count: 'exact', head: true }).eq('padrinho_id', tid);
    const { count: n2 } = await supabase.from('usuarios').select('*', { count: 'exact', head: true }).eq('avo_id', tid);
    const me = await bot.telegram.getMe();
    const DASH = `👤 *PAINEL* | Saldo: R$ ${esc(u.saldo.toFixed(2))}
L1: ${esc(n1 || 0)} | L2: ${esc(n2 || 0)}

🔗 *LINK:* \`https://t.me/${me.username}?start=${tid}\``;
    await ctx.editMessageText(DASH, {
      parse_mode: 'MarkdownV2',
      reply_markup: { inline_keyboard: [[{ text: "💸 SACAR", callback_data: "withdraw" }], [{ text: "⬅️ VOLTAR", callback_data: "back_to_start" }]] }
    });
  } catch (e) { ctx.answerCbQuery(); }
});

bot.command('admin', async (ctx) => {
  if (ctx.from.id.toString() !== config.ADMIN_ID) return;
  ctx.replyWithMarkdownV2(`⚙️ *ADMIN* | Preço: R$ ${esc(config.PRODUCT_PRICE)}\n\`/setpreco 19.90\``);
});

bot.command('setpreco', (ctx) => {
  if (ctx.from.id.toString() !== config.ADMIN_ID) return;
  const val = ctx.message.text.split(' ')[1];
  if (val) { config.PRODUCT_PRICE = val; ctx.reply(`✅ R$ ${val}`); }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, '0.0.0.0', async () => {
  log('SYSTEM', `Servidor Online | Porta ${PORT} | Webhook V3.004`);
  try { await bot.launch(); } catch (e) { log('ERROR', `Bot Fail: ${e.message}`); }
});
