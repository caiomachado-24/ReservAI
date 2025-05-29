const pool = require("../db");

// Encontra ou cria um cliente no banco de dados.
// Se o cliente existir, ele é retornado. Se não, um novo é criado.
// Tenta usar profileName do Twilio, se disponível.
async function encontrarOuCriarCliente(telefone, profileName = "Cliente") {
  let client;
  try {
    client = await pool.getConnection();
    let [rows] = await client.query(
      "SELECT id, nome, telefone FROM clientes WHERE telefone = ?",
      [telefone]
    );

    let cliente;
    if (rows.length > 0) {
      cliente = rows[0];
      // Se o profileName vindo do Twilio for diferente do nome atual no DB
      // e não for o nome padrão 'Cliente', atualiza o nome no DB.
      if (
        profileName &&
        profileName !== "Cliente" &&
        cliente.nome !== profileName
      ) {
        await client.query("UPDATE clientes SET nome = ? WHERE id = ?", [
          profileName,
          cliente.id,
        ]);
        cliente.nome = profileName; // Atualiza o objeto para o nome mais recente
        console.log(`Nome do cliente atualizado para: ${profileName}`);
      }
    } else {
      // Cliente não encontrado, cria um novo
      const nomeParaSalvar = profileName || "Cliente"; // Usa profileName se existir, senão 'Cliente'
      const [result] = await client.query(
        "INSERT INTO clientes (nome, telefone) VALUES (?, ?)",
        [nomeParaSalvar, telefone]
      );
      cliente = {
        id: result.insertId,
        nome: nomeParaSalvar,
        telefone: telefone,
      };
      console.log(`Novo cliente criado: ${nomeParaSalvar}`);
    }
    return cliente;
  } catch (error) {
    console.error("Erro ao encontrar ou criar cliente:", error);
    throw error;
  } finally {
    if (client) client.release();
  }
}

// Atualiza o nome de um cliente existente.
async function atualizarNomeCliente(clienteId, novoNome) {
  let client;
  try {
    client = await pool.getConnection();
    const [result] = await client.query(
      "UPDATE clientes SET nome = ? WHERE id = ?",
      [novoNome, clienteId]
    );
    if (result.affectedRows > 0) {
      console.log(`Nome do cliente ${clienteId} atualizado para: ${novoNome}`);
      // Retorna o cliente atualizado ou um sinal de sucesso
      const [updatedRows] = await client.query(
        "SELECT id, nome, telefone FROM clientes WHERE id = ?",
        [clienteId]
      );
      return updatedRows[0];
    }
    return null;
  } catch (error) {
    console.error("Erro ao atualizar nome do cliente:", error);
    throw error;
  } finally {
    if (client) client.release();
  }
}

module.exports = {
  encontrarOuCriarCliente,
  atualizarNomeCliente,
};
