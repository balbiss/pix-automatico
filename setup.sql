-- 1. Criar a tabela de usuários
CREATE TABLE IF NOT EXISTS usuarios (
    telegram_id TEXT PRIMARY KEY,
    padrinho_id TEXT REFERENCES usuarios(telegram_id),
    avo_id TEXT REFERENCES usuarios(telegram_id),
    saldo DECIMAL DEFAULT 0,
    is_active BOOLEAN DEFAULT FALSE,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT timezone('utc'::text, now())
);

-- 2. Criar função para incrementar saldo (RPC)
CREATE OR REPLACE FUNCTION increment_balance(user_id TEXT, amount DECIMAL)
RETURNS VOID AS $$
BEGIN
    UPDATE usuarios
    SET saldo = saldo + amount
    WHERE telegram_id = user_id;
END;
$$ LANGUAGE plpgsql;
