const pool = require("../db");

// Encontrar cliente pelo telefone, ou criar se não existir
async function encontrarOuCriarCliente(telefone, nome = "Cliente") {
  const [rows] = await pool.query("SELECT * FROM clientes WHERE telefone = ?", [
    telefone,
  ]);

  if (rows.length > 0) {
    return rows[0]; // cliente já existe
  } else {
    const [result] = await pool.query(
      "INSERT INTO clientes (telefone, nome, verified_at) VALUES (?, ?, NOW())",
      [telefone, nome]
    );

    return { id: result.insertId, telefone, nome };
  }
}

// (opcional) Atualizar nome do cliente se necessário
async function atualizarNomeCliente(id, nome) {
  await pool.query("UPDATE clientes SET nome = ? WHERE id = ?", [nome, id]);
}

module.exports = {
  encontrarOuCriarCliente,
  atualizarNomeCliente, // se quiser permitir edição depois
};
