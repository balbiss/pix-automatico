import 'dotenv/config';
import express from 'express';
import { Telegraf } from 'telegraf';
import { createClient } from '@supabase/supabase-js';
import axios from 'axios';

const VERSION = "V3.001";
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

// Configurações Dinâmicas (Admin pode alterar)
let config = {
  PRODUCT_PRICE: process.env.PRODUCT_PRICE || "19.90",
  COMMISSION_L1: process.env.COMMISSION_L1 || "6.00",
  COMMISSION_L2: process.env.COMMISSION_L2 || "3.00",
  ADMIN_ID: "7924857149" // Seu ID de Telegram (Extraído do log)
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

log('SYSTEM', `Iniciando Versão 3.000 - Admin Mode...`);

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
      description: `Premium Access - User ${telegramId}`,
      webhook_url: WEBHOOK_URL,
      client: {
        name: "Consumidor Final",
        cpf: "12345678909",
        email: "pagamento@botindicacao.com"
      }
    };
    const response = await axios.post(`${SYNCPAY_BASE_URL}/api/partner/v1/cash-in`, payload, {
      headers: { Authorization: `Bearer ${token}` }
    });
    return response.data;
  } catch (error) { throw error; }
}

// --- WEBHOOK ---
app.post('/webhook/syncpay', async (req, res) => {
  const { external_id, status } = req.body;
  if (['PAID', 'completed', 'success'].includes(status)) {
    try {
      const telegramId = external_id.split('_')[1];
      const { data: user } = await supabase.from('usuarios').select('*').eq('telegram_id', telegramId).single();
      if (!user || user.is_active) return res.send('OK');

      await supabase.from('usuarios').update({ is_active: true }).eq('telegram_id', telegramId);

      if (user.padrinho_id) {
        await supabase.rpc('increment_balance', { user_id: user.padrinho_id, amount: parseFloat(config.COMMISSION_L1) });
        if (user.avo_id) {
          await supabase.rpc('increment_balance', { user_id: user.avo_id, amount: parseFloat(config.COMMISSION_L2) });
        }
      }

      await bot.telegram.sendMessage(telegramId, `💎 *PAGAMENTO CONFIRMADO\\!*\n\nAproveite seu acesso exclusivo\\.`, { parse_mode: 'MarkdownV2' });
      await bot.telegram.sendDocument(telegramId, { source: './ebook.pdf' }).catch(() => log('ERROR', 'Falha ao enviar PDF'));
      return res.send('OK');
    } catch (err) { log('ERROR', `Erro Webhook: ${err.message}`); }
  }
  res.send('Aguardando');
});

// --- HELPER: MENU PRINCIPAL ---
const getStartMenu = () => ({
  text: `🚀 *BEM\\-VINDO AO IMPÉRIO DIGITAL\\!*

Você acaba de dar o primeiro passo para sua liberdade financeira\\. Explore nosso conteúdo exclusivo\\.

💰 *Oferta:* E\\-book Premium por apenas *R$ ${esc(config.PRODUCT_PRICE)}*
💎 *Afiliados:* Ganhe comissões em até 2 níveis\\!

Escolha uma opção:`,
  keyboard: {
    inline_keyboard: [
      [{ text: "💳 ADQUIRIR AGORA", callback_data: "buy_pix" }],
      [{ text: "📊 MEU PAINEL / AFILIADOS", callback_data: "profile" }]
    ]
  }
});

// --- COMANDOS BOT ---
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

bot.action('back_to_start', async (ctx) => {
  try {
    const menu = getStartMenu();
    await ctx.editMessageText(menu.text, { parse_mode: 'MarkdownV2', reply_markup: menu.keyboard });
  } catch (e) { ctx.answerCbQuery(); }
});

bot.action('buy_pix', async (ctx) => {
  try {
    await ctx.answerCbQuery("Gerando Pix...");
    const charge = await createSyncPayCharge(ctx.from.id.toString(), config.PRODUCT_PRICE);
    const pixCode = charge.pix_code || charge.pix_copy_and_paste || charge.qrcode;

    const msg = `⚡ *QUASE LÁ\\!*
      
1\\. Copie o código abaixo
2\\. Pague via *Pix Copia e Cola* no seu banco

\`${esc(pixCode)}\`

_A entrega é automática após pagar\\._`;

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

    const DASH = `👤 *SEU PAINEL DE CONTROLE*

💰 *Saldo:* R$ ${esc(u.saldo.toFixed(2))}
👥 *Nível 1:* ${esc(n1 || 0)} | *Nível 2:* ${esc(n2 || 0)}

🔗 *SEU LINK:*
\`https://t.me/${me.username}?start=${tid}\`

_Ganhe R$ ${esc(parseFloat(config.COMMISSION_L1).toFixed(2))} por venda direta\\!_`;

    await ctx.editMessageText(DASH, {
      parse_mode: 'MarkdownV2',
      reply_markup: {
        inline_keyboard: [
          [{ text: "💸 SACAR SALDO", callback_data: "withdraw" }],
          [{ text: "⬅️ VOLTAR", callback_data: "back_to_start" }]
        ]
      }
    });
  } catch (e) { ctx.answerCbQuery(); }
});

bot.action('withdraw', async (ctx) => {
  await ctx.editMessageText(`🏦 *SOLICITAÇÃO DE SAQUE*

Para sacar, use o comando:
\`/sacar SEU_CPF\`

_Mínimo R$ 50,00_`, {
    parse_mode: 'MarkdownV2',
    reply_markup: { inline_keyboard: [[{ text: "⬅️ CANCELAR", callback_data: "profile" }]] }
  });
});

// --- ADMIN PANEL ---
bot.command('admin', async (ctx) => {
  if (ctx.from.id.toString() !== config.ADMIN_ID) return;

  const { count: totalUsers } = await supabase.from('usuarios').select('*', { count: 'exact', head: true });
  const { data: actives } = await supabase.from('usuarios').select('*', { count: 'exact' }).eq('is_active', true);

  const ADMIN_MSG = `⚙️ *PAINEL ADMINISTRADOR*

📊 *Usuários:* ${esc(totalUsers)}
✅ *Vendas Realizadas:* ${esc(actives?.length || 0)}

💰 *Preço Atual:* R$ ${esc(config.PRODUCT_PRICE)}
🎁 *Comissão L1:* R$ ${esc(config.COMMISSION_L1)}
🎁 *Comissão L2:* R$ ${esc(config.COMMISSION_L2)}

*COMANDOS DE EDIÇÃO:*
\`/setpreco 19.90\`
\`/setcomissao1 6.00\`
\`/setcomissao2 3.00\`
\`/documento\` \\(Envie o PDF após este comando\\)`;

  ctx.replyWithMarkdownV2(ADMIN_MSG);
});

bot.command('setpreco', (ctx) => {
  if (ctx.from.id.toString() !== config.ADMIN_ID) return;
  const val = ctx.message.text.split(' ')[1];
  if (val) { config.PRODUCT_PRICE = val; ctx.reply(`✅ Preço atualizado para R$ ${val}`); }
});

bot.command('setcomissao1', (ctx) => {
  if (ctx.from.id.toString() !== config.ADMIN_ID) return;
  const val = ctx.message.text.split(' ')[1];
  if (val) { config.COMMISSION_L1 = val; ctx.reply(`✅ Comissão L1: R$ ${val}`); }
});

bot.on('document', async (ctx) => {
  if (ctx.from.id.toString() !== config.ADMIN_ID) return;
  // Aqui você poderia salvar o arquivo localmente, mas por simplicidade
  // avisaremos o admin que o arquivo ebook.pdf deve ser colocado na pasta app
  ctx.reply("📂 PDF Recebido! Certifique-se de que o nome do arquivo seja `ebook.pdf` e esteja na raiz do servidor.");
});

bot.command('sacar', async (ctx) => {
  const tid = ctx.from.id.toString();
  const cpf = ctx.message.text.split(' ')[1]?.replace(/\D/g, '');
  if (!cpf || cpf.length !== 11) return ctx.reply("❌ CPF Inválido.");

  try {
    const { data: u } = await supabase.from('usuarios').select('saldo').eq('telegram_id', tid).single();
    if (u.saldo < 50) return ctx.reply("❌ Saldo insuficiente.");
    await supabase.rpc('decrement_balance', { user_id: tid, amount: u.saldo });
    ctx.reply("✅ Saque solicitado!");
  } catch (e) { ctx.reply("❌ Erro no saque."); }
});

// Inicialização
const PORT = process.env.PORT || 3000;
app.listen(PORT, '0.0.0.0', async () => {
  log('SYSTEM', `Servidor na porta ${PORT}`);
  try {
    await bot.launch();
    log('SYSTEM', 'Bot Online - V3.000 Admin Mode');
  } catch (e) { log('ERROR', `Fail: ${e.message}`); }
});
