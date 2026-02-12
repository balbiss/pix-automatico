import 'dotenv/config';
import express from 'express';
import { Telegraf } from 'telegraf';
import { createClient } from '@supabase/supabase-js';
import axios from 'axios';

const VERSION = "V1.257";
const app = express();
app.use(express.json());

function log(tag, message) {
  const time = new Date().toLocaleTimeString('en-US', { hour12: false, hour: 'numeric', minute: '2-digit', second: '2-digit' });
  console.log(`[BOT LOG] [${VERSION}] ${time} - [${tag}] ${message}`);
}

// Configurações
const {
  SUPABASE_URL,
  SUPABASE_SERVICE_ROLE_KEY,
  TELEGRAM_BOT_TOKEN,
  SYNCPAY_CLIENT_ID,
  SYNCPAY_CLIENT_SECRET,
  SYNCPAY_BASE_URL,
  WEBHOOK_URL,
  PRODUCT_PRICE = 19.90,
  COMMISSION_L1 = 6.00,
  COMMISSION_L2 = 3.00
} = process.env;

// Inicialização Global
const supabase = createClient(SUPABASE_URL || 'http://localhost', SUPABASE_SERVICE_ROLE_KEY || 'key');
const bot = new Telegraf(TELEGRAM_BOT_TOKEN || '000:dummy');

log('SYSTEM', 'Iniciando Reconstrução V1.257...');

// --- LÓGICA SYNCPAY ---
async function getSyncPayToken() {
  try {
    const response = await axios.post(`${SYNCPAY_BASE_URL}/api/partner/v1/auth-token`, {
      client_id: SYNCPAY_CLIENT_ID,
      client_secret: SYNCPAY_CLIENT_SECRET
    });
    return response.data.access_token;
  } catch (error) {
    log('ERROR', `Erro Token SyncPay: ${error.message}`);
    throw error;
  }
}

async function createSyncPayCharge(telegramId, amount) {
  const token = await getSyncPayToken();
  try {
    const response = await axios.post(`${SYNCPAY_BASE_URL}/api/partner/v1/cash-in`, {
      external_id: telegramId,
      amount: parseFloat(amount),
      description: `Compra E-book - User ${telegramId}`,
      webhook_url: WEBHOOK_URL,
      client: {
        name: `Usuario ${telegramId}`,
        cpf: "00000000000",
        email: "bot@indicacao.com",
        phone: telegramId
      }
    }, { headers: { Authorization: `Bearer ${token}` } });
    return response.data;
  } catch (error) {
    const errorData = error.response?.data ? JSON.stringify(error.response.data) : error.message;
    log('ERROR', `Erro Cobrança (500): ${errorData}`);
    throw error;
  }
}

async function createSyncPayCashOut(amount, pixKey, telegramId) {
  const token = await getSyncPayToken();
  try {
    const response = await axios.post(`${SYNCPAY_BASE_URL}/api/partner/v1/cash-out`, {
      amount: parseFloat(amount),
      description: `Saque - User ${telegramId}`,
      pix_key_type: "CPF",
      pix_key: pixKey,
      document: { type: "cpf", number: pixKey }
    }, { headers: { Authorization: `Bearer ${token}` } });
    return response.data;
  } catch (error) {
    log('ERROR', `Erro Saque: ${error.message}`);
    throw error;
  }
}

// --- WEBHOOK ---
app.post('/webhook/syncpay', async (req, res) => {
  log('WEBHOOK', `Recebido: ${JSON.stringify(req.body)}`);
  const { external_id, status } = req.body;
  if (['PAID', 'completed', 'success'].includes(status)) {
    try {
      const telegramId = external_id;
      const { data: user } = await supabase.from('usuarios').select('*').eq('telegram_id', telegramId).single();
      if (!user || user.is_active) return res.send('OK');

      await supabase.from('usuarios').update({ is_active: true }).eq('telegram_id', telegramId);

      if (user.padrinho_id) {
        await supabase.rpc('increment_balance', { user_id: user.padrinho_id, amount: parseFloat(COMMISSION_L1) });
        if (user.avo_id) {
          await supabase.rpc('increment_balance', { user_id: user.avo_id, amount: parseFloat(COMMISSION_L2) });
        }
      }

      await bot.telegram.sendMessage(telegramId, "✅ Pagamento confirmado! Aqui está seu E-book:");
      await bot.telegram.sendDocument(telegramId, { source: './ebook.pdf' }).catch(() => log('ERROR', 'Falha ao enviar PDF'));
      return res.send('OK');
    } catch (err) {
      log('ERROR', `Erro Webhook: ${err.message}`);
    }
  }
  res.send('Aguardando');
});

// --- COMANDOS BOT ---
bot.start(async (ctx) => {
  const telegramId = ctx.from.id.toString();
  const startParam = ctx.startPayload;
  log('BOT', `Start do User ${telegramId}`);
  try {
    const { data: existingUser } = await supabase.from('usuarios').select('*').eq('telegram_id', telegramId).single();
    if (!existingUser) {
      let padrinhoId = null, avoId = null;
      if (startParam && startParam !== telegramId) {
        const { data: padrinho } = await supabase.from('usuarios').select('telegram_id, padrinho_id').eq('telegram_id', startParam).single();
        if (padrinho) { padrinhoId = padrinho.telegram_id; avoId = padrinho.padrinho_id; }
      }
      await supabase.from('usuarios').insert([{ telegram_id: telegramId, padrinho_id: padrinhoId, avo_id: avoId, saldo: 0, is_active: false }]);
    }
    ctx.reply(`Bem-vindo! E-book exclusivo por R$ ${PRODUCT_PRICE}.`, {
      reply_markup: { inline_keyboard: [[{ text: "Pagar com PIX", callback_data: "buy_pix" }], [{ text: "Meu Perfil / Indicar", callback_data: "profile" }]] }
    });
  } catch (e) { log('ERROR', `Erro /start: ${e.message}`); }
});

bot.action('buy_pix', async (ctx) => {
  try {
    const charge = await createSyncPayCharge(ctx.from.id.toString(), PRODUCT_PRICE);
    const pixCode = charge.pix_code || charge.pix_copy_and_paste || charge.qrcode;
    if (pixCode) ctx.reply(`Copia e Cola Pix:\n\n\`${pixCode}\``, { parse_mode: 'Markdown' });
  } catch (e) { ctx.reply("Erro ao gerar Pix."); }
});

bot.action('profile', async (ctx) => {
  const tid = ctx.from.id.toString();
  try {
    const { data: user } = await supabase.from('usuarios').select('*').eq('telegram_id', tid).single();
    const { count: n1 } = await supabase.from('usuarios').select('*', { count: 'exact', head: true }).eq('padrinho_id', tid);
    const { count: n2 } = await supabase.from('usuarios').select('*', { count: 'exact', head: true }).eq('avo_id', tid);
    const me = await bot.telegram.getMe();
    ctx.reply(`Sua Conta:\nSaldo: R$ ${user.saldo.toFixed(2)}\nN1: ${n1 || 0} | N2: ${n2 || 0}\n\nLink:\nhttps://t.me/${me.username}?start=${tid}`, {
      reply_markup: { inline_keyboard: [[{ text: "💰 Saque", callback_data: "withdraw" }], [{ text: "⬅️ Voltar", callback_data: "back_to_start" }]] }
    });
  } catch (e) { log('ERROR', 'Erro Perfil'); }
});

bot.action('withdraw', (ctx) => ctx.reply("Use `/sacar SEU_CPF` para retirar seu saldo."));

bot.command('sacar', async (ctx) => {
  const tid = ctx.from.id.toString();
  const cpf = ctx.message.text.split(' ')[1]?.replace(/\D/g, '');
  if (!cpf || cpf.length !== 11) return ctx.reply("Informe o CPF: `/sacar 12345678901`", { parse_mode: 'Markdown' });
  try {
    const { data: user } = await supabase.from('usuarios').select('saldo').eq('telegram_id', tid).single();
    if (user.saldo < 50) return ctx.reply("Saque mínimo R$ 50,00.");
    const res = await createSyncPayCashOut(user.saldo - 4.90, cpf, tid);
    if (res.reference_id) {
      await supabase.rpc('decrement_balance', { user_id: tid, amount: user.saldo });
      ctx.reply("✅ Saque solicitado!");
    }
  } catch (e) { ctx.reply("Erro no saque."); }
});

bot.action('back_to_start', (ctx) => {
  ctx.deleteMessage();
  ctx.reply(`E-book por R$ ${PRODUCT_PRICE}.`, {
    reply_markup: { inline_keyboard: [[{ text: "Pagar com PIX", callback_data: "buy_pix" }], [{ text: "Meu Perfil", callback_data: "profile" }]] }
  });
});

// Inicialização
const PORT = process.env.PORT || 3000;
app.listen(PORT, '0.0.0.0', async () => {
  log('SYSTEM', `Servidor na porta ${PORT}`);
  if (TELEGRAM_BOT_TOKEN && TELEGRAM_BOT_TOKEN !== '000:dummy') {
    try {
      await bot.launch();
      log('SYSTEM', 'Bot Online!');
    } catch (e) { log('ERROR', `Telegram Fail: ${e.message}`); }
  } else {
    log('ERROR', 'TELEGRAM_BOT_TOKEN ausente!');
  }
});

process.once('SIGINT', () => bot.stop('SIGINT'));
process.once('SIGTERM', () => bot.stop('SIGTERM'));
