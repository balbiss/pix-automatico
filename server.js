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

const VERSION = "v1.191";

function log(tag, message) {
  const time = new Date().toLocaleTimeString('en-US', { hour12: true, hour: 'numeric', minute: '2-digit', second: '2-digit' });
  console.log(`[BOT LOG] [${VERSION}] ${time} - [${tag}] ${message}`);
}

// Validação de Variáveis de Ambiente
const requiredEnv = [
  'SUPABASE_URL', 'SUPABASE_SERVICE_ROLE_KEY', 'TELEGRAM_BOT_TOKEN',
  'SYNCPAY_CLIENT_ID', 'SYNCPAY_CLIENT_SECRET', 'SYNCPAY_BASE_URL'
];

requiredEnv.forEach(env => {
  if (!process.env[env]) {
    log('ERROR', `Variável de ambiente ${env} não definida!`);
    process.exit(1);
  }
});

const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);
const bot = new Telegraf(TELEGRAM_BOT_TOKEN);

log('SYSTEM', 'Bot MLM Inicializado');
log('DATABASE', 'Conexão com Supabase configurada');

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
    const response = await axios.post(`${SYNCPAY_BASE_URL}/api/partner/v1/cash-in`, {
      amount: parseFloat(amount),
      description: `Compra E-book - User ${telegramId}`,
      webhook_url: WEBHOOK_URL,
      client: {
        name: `Usuario ${telegramId}`,
        cpf: "00000000000",
        email: "bot@indicacao.com",
        phone: telegramId
      }
    }, {
      headers: {
        Authorization: `Bearer ${token}`,
        'Accept': 'application/json',
        'Content-Type': 'application/json'
      }
    });

    return response.data;
  } catch (error) {
    console.error('Erro ao criar cobrança SyncPay:', error.response?.data || error.message);
    throw error;
  }
}


async function createSyncPayCashOut(amount, pixKey, telegramId) {
  const token = await getSyncPayToken();
  try {
    const response = await axios.post(`${SYNCPAY_BASE_URL}/api/partner/v1/cash-out`, {
      amount: parseFloat(amount),
      description: `Saque - User ${telegramId}`,
      pix_key_type: "CPF", // Assumindo CPF por padrão
      pix_key: pixKey,
      document: {
        type: "cpf",
        number: pixKey
      }
    }, {
      headers: {
        Authorization: `Bearer ${token}`,
        'Accept': 'application/json',
        'Content-Type': 'application/json'
      }
    });
    return response.data;
  } catch (error) {
    console.error('Erro ao processar saque SyncPay:', error.response?.data || error.message);
    throw error;
  }
}

// --- WEBHOOK SYNCPAY ---


app.post('/webhook/syncpay', async (req, res) => {
  console.log('Webhook recebido:', req.body);
  const { external_id, status } = req.body;

  // SyncPayments pode enviar 'PAID', 'completed' ou 'success' dependendo da versão
  if (status === 'PAID' || status === 'completed' || status === 'success') {
    try {
      const telegramId = external_id;

      // 1. Buscar usuário para verificar status e obter IDs de indicação
      const { data: user, error: userError } = await supabase
        .from('usuarios')
        .select('*')
        .eq('telegram_id', telegramId)
        .single();

      if (userError || !user) {
        console.error('Usuário não encontrado no webhook:', telegramId);
        return res.status(404).send('Usuário não encontrado');
      }

      if (user.is_active) {
        console.log('Usuário já está ativo:', telegramId);
        return res.send('OK');
      }

      // 2. Ativar usuário
      const { error: updateError } = await supabase
        .from('usuarios')
        .update({ is_active: true })
        .eq('telegram_id', telegramId);

      if (updateError) throw updateError;

      // 3. Distribuir comissões (Sistema de 2 níveis)
      // Nível 1: Padrinho (R$ 6,00)
      if (user.padrinho_id) {
        console.log(`Distribuindo R$ ${COMMISSION_L1} para o Padrinho: ${user.padrinho_id}`);
        await supabase.rpc('increment_balance', {
          user_id: user.padrinho_id,
          amount: parseFloat(COMMISSION_L1)
        });

        // Nível 2: Avô (R$ 3,00)
        if (user.avo_id) {
          console.log(`Distribuindo R$ ${COMMISSION_L2} para o Avô: ${user.avo_id}`);
          await supabase.rpc('increment_balance', {
            user_id: user.avo_id,
            amount: parseFloat(COMMISSION_L2)
          });
        }
      }

      // 4. Entrega Automática do E-book
      await bot.telegram.sendMessage(telegramId, "✅ Seu pagamento foi confirmado com sucesso!");
      await bot.telegram.sendMessage(telegramId, "Aqui está o seu E-book exclusivo. Aproveite a leitura! 📚");

      try {
        await bot.telegram.sendDocument(telegramId, { source: './ebook.pdf' });
      } catch (docError) {
        console.error('Erro ao enviar o arquivo PDF:', docError.message);
        await bot.telegram.sendMessage(telegramId, "Houve um problema ao enviar o arquivo automaticamente. Por favor, entre em contato com o suporte.");
      }

      return res.send('OK');
    } catch (error) {
      console.error('Erro ao processar webhook:', error);
      return res.status(500).send('Erro interno');
    }
  }

  res.send('Aguardando pagamento');
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
    // Ajustado para 'pix_code' conforme a documentação do Apidog
    const pixCode = charge.pix_code || charge.pix_copy_and_paste || charge.qrcode;

    if (pixCode) {
      await ctx.reply(`Utilize o código Pix abaixo para pagar:\n\n\`${pixCode}\``, { parse_mode: 'Markdown' });
    } else {
      throw new Error('Código Pix não gerado');
    }
  } catch (error) {

    await ctx.reply("Desculpe, houve um erro ao gerar o pagamento. Tente novamente mais tarde.");
  }
});

bot.command('carteira', async (ctx) => {
  return bot.handleContext(ctx.update, 'profile');
});

bot.action('profile', async (ctx) => {
  const telegramId = ctx.from.id.toString();
  try {
    // 1. Buscar dados do usuário
    const { data: user } = await supabase
      .from('usuarios')
      .select('*')
      .eq('telegram_id', telegramId)
      .single();

    // 2. Contar indicados Nível 1
    const { count: level1Count } = await supabase
      .from('usuarios')
      .select('*', { count: 'exact', head: true })
      .eq('padrinho_id', telegramId);

    // 3. Contar indicados Nível 2
    const { count: level2Count } = await supabase
      .from('usuarios')
      .select('*', { count: 'exact', head: true })
      .eq('avo_id', telegramId);

    const botInfo = await bot.telegram.getMe();
    const link = `https://t.me/${botInfo.username}?start=${telegramId}`;

    ctx.reply(`📊 Seu Perfil:\n\n` +
      `Status: ${user.is_active ? '✅ Ativo' : '❌ Inativo'}\n` +
      `Saldo: R$ ${user.saldo.toFixed(2)}\n\n` +
      `👥 Sua Rede:\n` +
      `Indicados Diretos (N1): ${level1Count || 0}\n` +
      `Indicados Indiretos (N2): ${level2Count || 0}\n\n` +
      `🔗 Seu Link de Indicação:\n${link}`, {
      reply_markup: {
        inline_keyboard: [
          [{ text: "💰 Solicitar Saque", callback_data: "withdraw" }],
          [{ text: "⬅️ Voltar", callback_data: "back_to_start" }]
        ]
      }
    });
  } catch (error) {
    console.error('Erro no perfil:', error);
    ctx.reply("Erro ao carregar perfil.");
  }
});

bot.action('withdraw', async (ctx) => {
  const telegramId = ctx.from.id.toString();
  try {
    const { data: user } = await supabase
      .from('usuarios')
      .select('saldo')
      .eq('telegram_id', telegramId)
      .single();

    if (user.saldo < 50) {
      return ctx.reply("❌ Saldo insuficiente. O valor mínimo para saque é R$ 50,00.");
    }

    ctx.reply("💰 Para realizar o saque, use o comando:\n\n`/sacar SEU_CPF` (apenas números)", { parse_mode: 'Markdown' });
  } catch (error) {
    ctx.reply("Erro ao verificar saldo.");
  }
});

bot.command('sacar', async (ctx) => {
  const telegramId = ctx.from.id.toString();
  const text = ctx.message.text.split(' ');

  if (text.length < 2) {
    return ctx.reply("❌ Por favor, informe seu CPF. Exemplo: `/sacar 12345678901`", { parse_mode: 'Markdown' });
  }

  const pixKey = text[1].replace(/\D/g, '');
  if (pixKey.length !== 11) {
    return ctx.reply("❌ CPF inválido. Use 11 dígitos numéricos.");
  }

  try {
    // 1. Verificar saldo novamente
    const { data: user } = await supabase
      .from('usuarios')
      .select('saldo')
      .eq('telegram_id', telegramId)
      .single();

    if (user.saldo < 50) {
      return ctx.reply("❌ Saldo insuficiente.");
    }

    const valorSaque = user.saldo;
    const taxaSaque = 4.90;
    const valorLiquido = valorSaque - taxaSaque;

    if (valorLiquido <= 0) {
      return ctx.reply("❌ Valor de saldo insuficiente para cobrir as taxas.");
    }

    await ctx.reply(`⏳ Processando seu saque de R$ ${valorSaque.toFixed(2)} (Taxa: R$ ${taxaSaque.toFixed(2)})...`);

    // 2. Chamar API SyncPay CashOut
    const res = await createSyncPayCashOut(valorLiquido, pixKey, telegramId);

    if (res.reference_id) {
      // 3. Deduzir saldo no Supabase
      await supabase.rpc('decrement_balance', {
        user_id: telegramId,
        amount: valorSaque
      });

      await ctx.reply(`✅ Saque solicitado com sucesso!\nReferência: ${res.reference_id}\n\nO valor de R$ ${valorLiquido.toFixed(2)} será enviado para sua chave Pix CPF.`);
    } else {
      throw new Error('Erro na resposta da API de Saque');
    }

  } catch (error) {
    console.error('Erro ao processar saque:', error);
    ctx.reply("❌ Ocorreu um erro ao processar seu saque. Verifique se seu CPF está correto e tente novamente.");
  }
});

bot.action('back_to_start', (ctx) => {
  ctx.deleteMessage();
  // Reinicia o fluxo start enviando a mensagem novamente
  ctx.reply(`Bem-vindo! Adquira agora o nosso E-book exclusivo por apenas R$ ${PRODUCT_PRICE}.\n\nPara comprar, use o botão abaixo:`, {
    reply_markup: {
      inline_keyboard: [
        [{ text: "Pagar com PIX", callback_data: "buy_pix" }],
        [{ text: "Meu Perfil / Indicar", callback_data: "profile" }]
      ]
    }
  });
});



// --- INICIALIZAÇÃO ---

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Servidor rodando na porta ${PORT}`);
  bot.launch();
});

process.once('SIGINT', () => bot.stop('SIGINT'));
process.once('SIGTERM', () => bot.stop('SIGTERM'));
