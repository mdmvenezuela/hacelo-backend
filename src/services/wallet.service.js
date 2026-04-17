const { transaction, query } = require('../config/db');

class WalletService {

  static async getWallet(userId) {
    const { rows } = await query('SELECT * FROM wallets WHERE user_id = $1', [userId]);
    if (!rows.length) throw new Error('Wallet no encontrada');
    return rows[0];
  }

  static async createWallet(userId) {
    const { rows } = await query('INSERT INTO wallets (user_id) VALUES ($1) RETURNING *', [userId]);
    return rows[0];
  }

  static async logTransaction(client, { walletId, type, status = 'approved', amount, balanceBefore, balanceAfter, referenceId = null, referenceType = null, description = null, metadata = {} }) {
    const { rows } = await client.query(`
      INSERT INTO wallet_transactions (wallet_id, type, status, amount, balance_before, balance_after, reference_id, reference_type, description, metadata)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING *
    `, [walletId, type, status, amount, balanceBefore, balanceAfter, referenceId, referenceType, description, JSON.stringify(metadata)]);
    return rows[0];
  }

  static async credit(userId, amount, { referenceId, referenceType, description, metadata } = {}) {
    return transaction(async (client) => {
      const { rows: [wallet] } = await client.query('SELECT * FROM wallets WHERE user_id = $1 FOR UPDATE', [userId]);
      const balanceBefore = parseFloat(wallet.balance);
      const balanceAfter  = balanceBefore + parseFloat(amount);
      await client.query('UPDATE wallets SET balance = $1 WHERE user_id = $2', [balanceAfter, userId]);
      await this.logTransaction(client, { walletId: wallet.id, type: 'recharge', status: 'approved', amount, balanceBefore, balanceAfter, referenceId, referenceType, description, metadata });
      return { balance: balanceAfter, blocked: parseFloat(wallet.blocked_balance) };
    });
  }

  static async blockFunds(userId, amount, { orderId, description } = {}) {
    return transaction(async (client) => {
      const { rows: [wallet] } = await client.query('SELECT * FROM wallets WHERE user_id = $1 FOR UPDATE', [userId]);
      const available = parseFloat(wallet.balance);
      if (available < parseFloat(amount)) throw new Error(`Saldo insuficiente. Disponible: $${available.toFixed(2)}, requerido: $${amount}`);
      const balanceBefore = available;
      const balanceAfter  = available - parseFloat(amount);
      const blockedAfter  = parseFloat(wallet.blocked_balance) + parseFloat(amount);
      await client.query('UPDATE wallets SET balance = $1, blocked_balance = $2 WHERE user_id = $3', [balanceAfter, blockedAfter, userId]);
      await this.logTransaction(client, { walletId: wallet.id, type: 'visit_block', status: 'approved', amount, balanceBefore, balanceAfter, referenceId: orderId, referenceType: 'order', description: description || `Bloqueo por orden #${orderId}` });
      return { balance: balanceAfter, blocked: blockedAfter };
    });
  }

  static async unblockFunds(userId, amount, { orderId, type = 'visit_unblock' } = {}) {
    return transaction(async (client) => {
      const { rows: [wallet] } = await client.query('SELECT * FROM wallets WHERE user_id = $1 FOR UPDATE', [userId]);
      const blocked = parseFloat(wallet.blocked_balance);
      if (blocked < parseFloat(amount)) throw new Error('Saldo bloqueado insuficiente para desbloquear');
      const balanceBefore = parseFloat(wallet.balance);
      const balanceAfter  = balanceBefore + parseFloat(amount);
      const blockedAfter  = blocked - parseFloat(amount);
      await client.query('UPDATE wallets SET balance = $1, blocked_balance = $2 WHERE user_id = $3', [balanceAfter, blockedAfter, userId]);
      await this.logTransaction(client, { walletId: wallet.id, type, status: 'approved', amount, balanceBefore, balanceAfter, referenceId: orderId, referenceType: 'order', description: `Desbloqueo de fondos - Orden #${orderId}` });
      return { balance: balanceAfter, blocked: blockedAfter };
    });
  }

  static async chargeVisit(clientId, providerId, amount, orderId) {
    return transaction(async (client) => {
      // Descontar del blocked del cliente
      const { rows: [clientWallet] } = await client.query('SELECT * FROM wallets WHERE user_id = $1 FOR UPDATE', [clientId]);
      const clientBlockedNew = parseFloat(clientWallet.blocked_balance) - parseFloat(amount);
      if (clientBlockedNew < 0) throw new Error('Saldo bloqueado insuficiente del cliente');
      await client.query('UPDATE wallets SET blocked_balance = $1 WHERE user_id = $2', [clientBlockedNew, clientId]);
      await this.logTransaction(client, { walletId: clientWallet.id, type: 'visit_charge', status: 'approved', amount, balanceBefore: parseFloat(clientWallet.balance), balanceAfter: parseFloat(clientWallet.balance), referenceId: orderId, referenceType: 'order', description: `Cobro de visita - Orden #${orderId}` });

      // Comisión
      const { rows: [pp] } = await client.query(`SELECT pp.level FROM provider_profiles pp WHERE pp.user_id = $1`, [providerId]);
      const rates = { lila: parseFloat(process.env.COMMISSION_LILA || 0.135), plata: parseFloat(process.env.COMMISSION_PLATA || 0.12), oro: parseFloat(process.env.COMMISSION_ORO || 0.10) };
      const rate       = rates[pp?.level || 'lila'];
      const commission = parseFloat((parseFloat(amount) * rate).toFixed(2));
      const netAmount  = parseFloat((parseFloat(amount) - commission).toFixed(2));

      // Acreditar al proveedor
      const { rows: [provWallet] } = await client.query('SELECT * FROM wallets WHERE user_id = $1 FOR UPDATE', [providerId]);
      const provBalanceAfter = parseFloat(provWallet.balance) + netAmount;
      await client.query('UPDATE wallets SET balance = $1, total_earned = total_earned + $2 WHERE user_id = $3', [provBalanceAfter, netAmount, providerId]);
      await this.logTransaction(client, { walletId: provWallet.id, type: 'visit_charge', status: 'approved', amount: netAmount, balanceBefore: parseFloat(provWallet.balance), balanceAfter: provBalanceAfter, referenceId: orderId, referenceType: 'order', description: `Cobro de visita (comisión ${(rate*100).toFixed(1)}% descontada)`, metadata: { grossAmount: amount, commission, rate } });

      await client.query(`UPDATE orders SET visit_paid = true, visit_charged_at = NOW(), commission_rate = $1, commission_amount = COALESCE(commission_amount, 0) + $2 WHERE id = $3`, [rate, commission, orderId]);

      return { netAmount, commission, rate };
    });
  }

  static async releaseWorkPayment(clientId, providerId, amount, orderId) {
    return transaction(async (client) => {
      // Quitar del blocked del cliente
      const { rows: [clientWallet] } = await client.query('SELECT * FROM wallets WHERE user_id = $1 FOR UPDATE', [clientId]);
      const newBlocked = parseFloat(clientWallet.blocked_balance) - parseFloat(amount);
      if (newBlocked < 0) throw new Error('Saldo bloqueado insuficiente');
      await client.query('UPDATE wallets SET blocked_balance = $1 WHERE user_id = $2', [newBlocked, clientId]);
      await this.logTransaction(client, { walletId: clientWallet.id, type: 'work_release', status: 'approved', amount, balanceBefore: parseFloat(clientWallet.balance), balanceAfter: parseFloat(clientWallet.balance), referenceId: orderId, referenceType: 'order', description: `Pago liberado al proveedor - Orden #${orderId}` });

      // Comisión
      const { rows: [pp] } = await client.query(`SELECT level FROM provider_profiles WHERE user_id = $1`, [providerId]);
      const rates = { lila: parseFloat(process.env.COMMISSION_LILA || 0.135), plata: parseFloat(process.env.COMMISSION_PLATA || 0.12), oro: parseFloat(process.env.COMMISSION_ORO || 0.10) };
      const rate       = rates[pp?.level || 'lila'];
      const commission = parseFloat((parseFloat(amount) * rate).toFixed(2));
      const netAmount  = parseFloat((parseFloat(amount) - commission).toFixed(2));

      // Acreditar al proveedor
      const { rows: [provWallet] } = await client.query('SELECT * FROM wallets WHERE user_id = $1 FOR UPDATE', [providerId]);
      const newBalance = parseFloat(provWallet.balance) + netAmount;
      await client.query('UPDATE wallets SET balance = $1, total_earned = total_earned + $2 WHERE user_id = $3', [newBalance, netAmount, providerId]);
      await this.logTransaction(client, { walletId: provWallet.id, type: 'work_release', status: 'approved', amount: netAmount, balanceBefore: parseFloat(provWallet.balance), balanceAfter: newBalance, referenceId: orderId, referenceType: 'order', description: `Pago de trabajo recibido - Orden #${orderId}`, metadata: { grossAmount: amount, commission, rate } });

      // Actualizar orden
      await client.query(`UPDATE orders SET work_paid = true, work_paid_at = NOW(), commission_amount = COALESCE(commission_amount, 0) + $1 WHERE id = $2`, [commission, orderId]);

      // ── FIX: cast explícito a provider_level ─────────────────
      await client.query(`
        UPDATE provider_profiles
        SET points = points + 1,
            orders_completed = orders_completed + 1,
            level = CASE
              WHEN points + 1 > $1 THEN 'oro'::provider_level
              WHEN points + 1 > $2 THEN 'plata'::provider_level
              ELSE 'lila'::provider_level
            END
        WHERE user_id = $3
      `, [
        parseInt(process.env.POINTS_PLATA_MAX || 200),
        parseInt(process.env.POINTS_LILA_MAX  || 50),
        providerId
      ]);

      return { netAmount, commission, rate };
    });
  }
}

module.exports = WalletService;
