import 'dotenv/config';
import express from 'express';
import { Telegraf } from 'telegraf';
import { createClient } from '@supabase/supabase-js';
import axios from 'axios';

const VERSION = "V2.001";
const app = express();
app.use(express.json());

function log(tag, message) {
  const time = new Date().toLocaleTimeString('en-US', { hour12: false, hour: 'numeric', minute: '2-digit', second: '2-digit' });
  console.log(`[BOT LOG] [${VERSION}] ${time} - [${tag}] ${message}`);
}

const escapeMarkdown = (text) => {
  return text.replace(/[_*[\]()~`>#+\-=|{}.!]/g, '\\$&');
};

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

log('SYSTEM', `Upgrade para Versão Profissional ${VERSION}...`);

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
    const payload = {
      external_id: `TX_${telegramId}_${Date.now()}`,
      amount: parseFloat(amount),
      description: `Compra E-book Premium - User ${telegramId}`,
      webhook_url: WEBHOOK_URL,
      client: {
        name: "Consumidor Final",
        cpf: "12345678909",
        email: "pagamento@botindicacao.com"
      }
    };

    log('DEBUG', `Payload Enviado: ${JSON.stringify(payload)}`);

    const response = await axios.post(`${SYNCPAY_BASE_URL}/api/partner/v1/cash-in`, payload, {
      headers: { Authorization: `Bearer ${token}` }
    });
    return response.data;
  } catch (error) {
    const errorData = error.response?.data ? JSON.stringify(error.response.data) : error.message;
    log('ERROR', `Erro Cobrança: ${errorData}`);
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
      // O external_id agora é TX_ID_TIMESTAMP, precisamos pegar o ID original
      const telegramId = external_id.split('_')[1];
      const { data: user } = await supabase.from('usuarios').select('*').eq('telegram_id', telegramId).single();

      if (!user || user.is_active) return res.send('OK');

      await supabase.from('usuarios').update({ is_active: true }).eq('telegram_id', telegramId);

      if (user.padrinho_id) {
        await supabase.rpc('increment_balance', { user_id: user.padrinho_id, amount: parseFloat(COMMISSION_L1) });
        if (user.avo_id) {
          await supabase.rpc('increment_balance', { user_id: user.avo_id, amount: parseFloat(COMMISSION_L2) });
        }
      }

      const msg = "💎 *PAGAMENTO CONFIRMADO\\!*\n\nParabéns\\! Sua compra foi processada com sucesso\\. Aproveite o conteúdo exclusivo do nosso E\\-book\\.";
      await bot.telegram.sendMessage(telegramId, msg, { parse_mode: 'MarkdownV2' });
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

    const WELCOME_MSG = `🚀 *BEM\\-VINDO AO IMPÉRIO DIGITAL\\!*

Você acaba de dar o primeiro passo para sua liberdade financeira\\. Explore nosso conteúdo exclusivo e comece a lucrar agora mesmo\\.

💰 *Oferta Especial:* E\\-book Premium por apenas *R$ ${PRODUCT_PRICE}*
💎 *Sistema de Afiliados:* Ganhe comissões em até 2 níveis\\!

Escolha uma opção abaixo para começar:`;

    ctx.replyWithMarkdownV2(WELCOME_MSG, {
      reply_markup: {
        inline_keyboard: [
          [{ text: "💳 ADQUIRIR E-BOOK AGORA", callback_data: "buy_pix" }],
          [{ text: "📊 MEU PAINEL / AFILIADOS", callback_data: "profile" }]
        ]
      }
    });
  } catch (e) { log('ERROR', `Erro /start: ${e.message}`); }
});

bot.action('buy_pix', async (ctx) => {
  try {
    await ctx.answerCbQuery("Gerando seu Pix...");
    const charge = await createSyncPayCharge(ctx.from.id.toString(), PRODUCT_PRICE);
    const pixCode = charge.pix_code || charge.pix_copy_and_paste || charge.qrcode;

    if (pixCode) {
      const msg = `⚡ *QUASE LÁ\\!*
      
Siga os passos para liberar seu acesso:
1\\. Copie o código abaixo
2\\. Abra o app do seu banco
3\\. Vá em *Pix Copia e Cola*
4\\. Cole o código e finalize o pagamento

\`${pixCode}\`

_A liberação do E\\-book ocorre automaticamente após a confirmação\\._`;

      ctx.replyWithMarkdownV2(msg);
    } else {
      ctx.reply("❌ Erro temporário no sistema de pagamentos. Tente novamente em alguns minutos.");
    }
  } catch (e) { ctx.reply("❌ Não foi possível gerar o Pix no momento."); }
});

bot.action('profile', async (ctx) => {
  const tid = ctx.from.id.toString();
  try {
    await ctx.answerCbQuery();
    const { data: user } = await supabase.from('usuarios').select('*').eq('telegram_id', tid).single();
    const { count: n1 } = await supabase.from('usuarios').select('*', { count: 'exact', head: true }).eq('padrinho_id', tid);
    const { count: n2 } = await supabase.from('usuarios').select('*', { count: 'exact', head: true }).eq('avo_id', tid);
    const me = await bot.telegram.getMe();

    const DASHBOARD = `👤 *SEU PAINEL DE CONTROLE*

💰 *Saldo Disponível:* R$ ${user.saldo.toFixed(2).replace('.', '\\.')}
👥 *Rede Nível 1:* ${n1 || 0} consultores
👥 *Rede Nível 2:* ${n2 || 0} consultores

🔗 *SEU LINK DE INDICAÇÃO:*
\`https://t.me/${me.username}?start=${tid}\`

_Indique amigos e ganhe R$ ${COMMISSION_L1.toFixed(2).replace('.', '\\.')} por cada venda direta\\!_`;

    ctx.replyWithMarkdownV2(DASHBOARD, {
      reply_markup: {
        inline_keyboard: [
          [{ text: "💸 SACAR COMISSÕES", callback_data: "withdraw" }],
          [{ text: "⬅️ VOLTAR AO INÍCIO", callback_data: "back_to_start" }]
        ]
      }
    });
  } catch (e) { log('ERROR', 'Erro Perfil'); }
});

bot.action('withdraw', (ctx) => {
  ctx.replyWithMarkdownV2("🏦 *SOLICITAÇÃO DE SAQUE*\n\nPara retirar seu saldo, informe seu CPF utilizando o comando:\n\n\` /sacar 000.000.000-00 \`\n\n_Saque mínimo: R$ 50,00_");
});

bot.command('sacar', async (ctx) => {
  const tid = ctx.from.id.toString();
  const input = ctx.message.text.split(' ')[1];
  const cpf = input?.replace(/\D/g, '');

  if (!cpf || cpf.length !== 11) {
    return ctx.replyWithMarkdownV2("❌ *CPF INVÁLIDO*\nInforme o CPF corretamente: \`/sacar 12345678901\`");
  }

  try {
    const { data: user } = await supabase.from('usuarios').select('saldo').eq('telegram_id', tid).single();
    if (user.saldo < 50) return ctx.reply("❌ Saldo insuficiente para saque (Mínimo R$ 50,00).");

    const res = await createSyncPayCashOut(user.saldo - 4.90, cpf, tid);
    if (res.reference_id) {
      await supabase.rpc('decrement_balance', { user_id: tid, amount: user.saldo });
      ctx.replyWithMarkdownV2("✅ *SAQUE SOLICITADO\\!* Seu saldo será processado em breve\\.");
    }
  } catch (e) { ctx.reply("❌ Erro ao processar saque. Verifique se o CPF é o mesmo do cadastro."); }
});

bot.action('back_to_start', (ctx) => {
  ctx.deleteMessage();
  ctx.replyWithMarkdownV2(`💎 *E\\-BOOK PREMIUM* \\- R$ ${PRODUCT_PRICE.replace(/\./g, '\\.')}\n\nDeseja realizar sua compra agora?`, {
    reply_markup: {
      inline_keyboard: [
        [{ text: "💳 PAGAR AGORA", callback_data: "buy_pix" }],
        [{ text: "📊 MEU PAINEL", callback_data: "profile" }]
      ]
    }
  });
});

// Inicialização
const PORT = process.env.PORT || 3000;
app.listen(PORT, '0.0.0.0', async () => {
  log('SYSTEM', `Servidor na porta ${PORT}`);
  if (TELEGRAM_BOT_TOKEN && TELEGRAM_BOT_TOKEN !== '000:dummy') {
    try {
      await bot.launch();
      log('SYSTEM', 'Bot Online - Versão Profissional!');
    } catch (e) { log('ERROR', `Telegram Fail: ${e.message}`); }
  } else {
    log('ERROR', 'TELEGRAM_BOT_TOKEN ausente!');
  }
});

process.once('SIGINT', () => bot.stop('SIGINT'));
process.once('SIGTERM', () => bot.stop('SIGTERM'));
