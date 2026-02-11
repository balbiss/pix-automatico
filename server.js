import 'dotenv/config';
import express from 'express';
import { Telegraf } from 'telegraf';
import { createClient } from '@supabase/supabase-js';
import axios from 'axios';

const app = express();
app.use(express.json());

// Configurações
const {
  SUPABASE_URL,
  SUPABASE_SERVICE_ROLE_KEY,
  TELEGRAM_BOT_TOKEN,
  SYNCPAY_CLIENT_ID,
  SYNCPAY_CLIENT_SECRET,
  SYNCPAY_BASE_URL,
  WEBHOOK_URL,
  PRODUCT_PRICE,
  COMMISSION_L1,
  COMMISSION_L2
} = process.env;

const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);
const bot = new Telegraf(TELEGRAM_BOT_TOKEN);

// --- LÓGICA SYNCPAY ---

async function getSyncPayToken() {
  try {
    const response = await axios.post(`${SYNCPAY_BASE_URL}/api/partner/v1/auth-token`, {
      client_id: SYNCPAY_CLIENT_ID,
      client_secret: SYNCPAY_CLIENT_SECRET
    });
    return response.data.access_token;
  } catch (error) {
    console.error('Erro ao obter token SyncPay:', error.response?.data || error.message);
    throw error;
  }
}

async function createSyncPayCharge(telegramId, amount) {
  const token = await getSyncPayToken();
  try {
    const response = await axios.post(`${SYNCPAY_BASE_URL}/api/partner/v1/pix/cashin`, {
      amount: parseFloat(amount),
      external_id: telegramId,
      callback_url: WEBHOOK_URL
    }, {
      headers: { Authorization: `Bearer ${token}` }
    });
    return response.data; // Deve conter o copia e cola e o QR Code
  } catch (error) {
    console.error('Erro ao criar cobrança SyncPay:', error.response?.data || error.message);
    throw error;
  }
}

// --- WEBHOOK SYNCPAY ---

app.post('/webhook/syncpay', async (req, res) => {
  const { external_id, status } = req.body;

  if (status === 'PAID' || status === 'completed') {
    try {
      // 1. Buscar usuário
      const { data: user, error: userError } = await supabase
        .from('usuarios')
        .select('*')
        .eq('telegram_id', external_id)
        .single();

      if (userError || !user) throw new Error('Usuário não encontrado');
      if (user.is_active) return res.send('OK'); // Já ativado

      // 2. Ativar usuário
      await supabase
        .from('usuarios')
        .update({ is_active: true })
        .eq('telegram_id', external_id);

      // 3. Distribuir comissões
      if (user.padrinho_id) {
        // Nível 1
        await supabase.rpc('increment_balance', {
          user_id: user.padrinho_id,
          amount: parseFloat(COMMISSION_L1)
        });

        if (user.avo_id) {
          // Nível 2
          await supabase.rpc('increment_balance', {
            user_id: user.avo_id,
            amount: parseFloat(COMMISSION_L2)
          });
        }
      }

      // 4. Enviar E-book via Bot
      await bot.telegram.sendMessage(external_id, "✅ Pagamento confirmado! Aqui está o seu E-book:");
      await bot.telegram.sendDocument(external_id, { source: './ebook.pdf' });

      return res.send('OK');
    } catch (error) {
      console.error('Erro no processamento do webhook:', error);
      return res.status(500).send('Erro interno');
    }
  }

  res.send('NOT_PAID');
});

// --- LÓGICA DO BOT ---

bot.start(async (ctx) => {
  const telegramId = ctx.from.id.toString();
  const startParam = ctx.startPayload; // ID do padrinho se houver

  try {
    // Verificar se usuário já existe
    const { data: existingUser } = await supabase
      .from('usuarios')
      .select('*')
      .eq('telegram_id', telegramId)
      .single();

    if (!existingUser) {
      let padrinhoId = null;
      let avoId = null;

      if (startParam && startParam !== telegramId) {
        // Buscar padrinho para pegar o avô dele
        const { data: padrinho } = await supabase
          .from('usuarios')
          .select('telegram_id, padrinho_id')
          .eq('telegram_id', startParam)
          .single();

        if (padrinho) {
          padrinhoId = padrinho.telegram_id;
          avoId = padrinho.padrinho_id;
        }
      }

      await supabase.from('usuarios').insert([{
        telegram_id: telegramId,
        padrinho_id: padrinhoId,
        avo_id: avoId,
        saldo: 0,
        is_active: false
      }]);
    }

    ctx.reply(`Bem-vindo! Adquira agora o nosso E-book exclusivo por apenas R$ ${PRODUCT_PRICE}.\n\nPara comprar, use o botão abaixo:`, {
      reply_markup: {
        inline_keyboard: [
          [{ text: "Pagar com PIX", callback_data: "buy_pix" }],
          [{ text: "Meu Perfil / Indicar", callback_data: "profile" }]
        ]
      }
    });
  } catch (error) {
    console.error('Erro no /start:', error);
  }
});

bot.action('buy_pix', async (ctx) => {
  const telegramId = ctx.from.id.toString();
  await ctx.reply("Gerando seu PIX, aguarde...");

  try {
    const charge = await createSyncPayCharge(telegramId, PRODUCT_PRICE);
    // Ajustar campos conforme retorno real da SyncPay (ex: qrcode, pix_copy_and_paste)
    await ctx.reply(`Utilize o código Pix abaixo para pagar:\n\n\`${charge.pix_copy_and_paste || charge.qrcode}\``, { parse_mode: 'Markdown' });
  } catch (error) {
    await ctx.reply("Desculpe, houve um erro ao gerar o pagamento. Tente novamente mais tarde.");
  }
});

bot.action('profile', async (ctx) => {
  const telegramId = ctx.from.id.toString();
  try {
    const { data: user } = await supabase
      .from('usuarios')
      .select('*')
      .eq('telegram_id', telegramId)
      .single();

    const botInfo = await bot.telegram.getMe();
    const link = `https://t.me/${botInfo.username}?start=${telegramId}`;
    ctx.reply(`Seu Perfil:\nStatus: ${user.is_active ? '✅ Ativo' : '❌ Inativo'}\nSaldo: R$ ${user.saldo.toFixed(2)}\n\nIndique e Ganhe:\n${link}`);
  } catch (error) {
    ctx.reply("Erro ao carregar perfil.");
  }
});

// --- INICIALIZAÇÃO ---

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Servidor rodando na porta ${PORT}`);
  bot.launch();
});

process.once('SIGINT', () => bot.stop('SIGINT'));
process.once('SIGTERM', () => bot.stop('SIGTERM'));
