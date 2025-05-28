const pool = require("../db");

async function encontrarOuCriarCliente(telefone, nomePadrao = "Cliente") {
  const numeroLimpo = telefone.replace(/^whatsapp:/i, "").trim();

  try {
    const [rows] = await pool.query(
      "SELECT id, nome, telefone FROM clientes WHERE telefone = ?",
      [numeroLimpo]
    );

    if (rows.length > 0) {
      return rows[0];
    }

    const [result] = await pool.query(
      "INSERT INTO clientes (telefone, nome, verified_at) VALUES (?, ?, NOW())",
      [numeroLimpo, nomePadrao]
    );

    return { id: result.insertId, nome: nomePadrao, telefone: numeroLimpo };
  } catch (error) {
    console.error("Erro em encontrarOuCriarCliente:", error);
    throw new Error("Falha ao encontrar ou criar cliente: " + error.message);
  }
}

async function atualizarNomeCliente(clienteId, novoNome) {
  try {
    const [result] = await pool.query(
      "UPDATE clientes SET nome = ? WHERE id = ?",
      [novoNome, clienteId]
    );

    return result.affectedRows > 0;
  } catch (error) {
    console.error("Erro em atualizarNomeCliente:", error);
    throw new Error("Falha ao atualizar nome do cliente: " + error.message);
  }
}

module.exports = { encontrarOuCriarCliente, atualizarNomeCliente };
