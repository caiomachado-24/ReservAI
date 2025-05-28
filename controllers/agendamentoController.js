// controllers/agendamentoController.js
const pool = require("../db"); // Importa o pool de conexões do banco de dados

/**
 * Busca um serviço específico pelo nome no banco de dados.
 * @param {string} nomeServico - O nome do serviço a ser buscado.
 * @returns {Promise<Object|null>} Um objeto contendo o ID e nome do serviço, ou null se não encontrado.
 * @throws {Error} Se ocorrer um erro durante a consulta ao banco de dados.
 */
async function buscarServicoPorNome(nomeServico) {
  try {
    const [rows] = await pool.query(
      "SELECT id, nome FROM servicos WHERE nome = ?",
      [nomeServico]
    );
    return rows.length > 0 ? rows[0] : null;
  } catch (error) {
    console.error("Erro ao buscar serviço por nome:", error);
    // Re-lança o erro para que seja tratado em um nível superior (ex: no webhook)
    throw new Error("Falha ao buscar serviço: " + error.message);
  }
}

/**
 * Busca um barbeiro específico pelo nome no banco de dados.
 * @param {string} nomeBarbeiro - O nome do barbeiro a ser buscado.
 * @returns {Promise<Object|null>} Um objeto contendo o ID, nome e especialidade do barbeiro, ou null se não encontrado.
 * @throws {Error} Se ocorrer um erro durante a consulta ao banco de dados.
 */
async function buscarBarbeiroPorNome(nomeBarbeiro) {
  try {
    const [rows] = await pool.query(
      "SELECT id, nome, especialidade FROM barbeiros WHERE nome = ?",
      [nomeBarbeiro]
    );
    return rows.length > 0 ? rows[0] : null;
  } catch (error) {
    console.error("Erro ao buscar barbeiro por nome:", error);
    throw new Error("Falha ao buscar barbeiro: " + error.message);
  }
}

/**
 * Lista todos os barbeiros cadastrados no banco de dados.
 * @returns {Promise<Array<Object>>} Um array de objetos, cada um representando um barbeiro.
 * @throws {Error} Se ocorrer um erro durante a consulta ao banco de dados.
 */
async function listarBarbeiros() {
  try {
    const [rows] = await pool.query(
      "SELECT id, nome FROM barbeiros ORDER BY nome"
    );
    return rows;
  } catch (error) {
    console.error("Erro ao listar barbeiros:", error);
    throw new Error("Falha ao listar barbeiros: " + error.message);
  }
}

/**
 * Busca horários disponíveis no banco de dados, opcionalmente filtrando por um barbeiro específico.
 * Retorna apenas os horários marcados como 'disponivel' e que ainda não passaram.
 * @param {number|null} barbeiroId - O ID do barbeiro para filtrar os horários, ou null para todos os barbeiros.
 * @returns {Promise<Array<Object>>} Um array de objetos, cada um representando um horário disponível.
 * @throws {Error} Se ocorrer um erro durante a consulta ao banco de dados.
 */
async function buscarHorariosDisponiveis(barbeiroId = null) {
  let query = `
    SELECT hd.id, hd.dia_horario, hd.dia_semana, b.nome AS barbeiro_nome, b.id AS barbeiro_id
    FROM horarios_disponiveis hd
    JOIN barbeiros b ON hd.barbeiro_id = b.id
    WHERE hd.disponivel = TRUE
    AND hd.dia_horario > NOW() -- Filtra apenas horários que ainda não passaram
  `;
  let queryParams = [];

  if (barbeiroId) {
    query += ` AND hd.barbeiro_id = ?`;
    queryParams.push(barbeiroId);
  }

  query += ` ORDER BY hd.dia_horario LIMIT 10`; // Limita a quantidade de horários para a resposta do bot

  try {
    const [rows] = await pool.query(query, queryParams);
    console.log("Horários disponíveis retornados do DB:", rows); // Log para depuração
    return rows;
  } catch (error) {
    console.error("Erro ao buscar horários disponíveis:", error);
    throw new Error("Falha ao buscar horários disponíveis: " + error.message);
  }
}

/**
 * Agenda um serviço para um cliente em um horário e com um barbeiro específico.
 * Esta função utiliza uma transação para garantir que as operações de agendamento
 * (marcar horário como indisponível e inserir agendamento) sejam atômicas.
 * @param {number} clienteId - O ID do cliente que está agendando.
 * @param {Array<number>} servicoIds - Um array de IDs dos serviços a serem agendados.
 * @param {number} horarioId - O ID do horário disponível que está sendo agendado.
 * @param {number} barbeiroId - O ID do barbeiro associado ao horário.
 * @returns {Promise<void>} Uma Promise que resolve se o agendamento for bem-sucedido.
 * @throws {Error} Se ocorrer um erro durante a transação ou qualquer operação de DB.
 */
async function agendarServico(clienteId, servicoIds, horarioId, barbeiroId) {
  let connection; // Variável para armazenar a conexão do pool

  try {
    connection = await pool.getConnection(); // Obtém uma conexão do pool
    await connection.beginTransaction(); // Inicia uma transação para atomicidade

    // 1. Marca o horário selecionado como indisponível
    await connection.query(
      "UPDATE horarios_disponiveis SET disponivel = FALSE WHERE id = ?",
      [horarioId]
    );

    // 2. Insere os registros de agendamento na tabela 'agendamentos'
    // Um registro de agendamento é criado para cada serviço selecionado
    for (const servicoId of servicoIds) {
      await connection.query(
        "INSERT INTO agendamentos (cliente_id, servico_id, horario_id, barbeiro_id) VALUES (?, ?, ?, ?)",
        [clienteId, servicoId, horarioId, barbeiroId]
      );
    }

    await connection.commit(); // Confirma todas as operações da transação
    console.log(
      `Agendamento confirmado para o cliente ${clienteId} no horário ${horarioId} com o barbeiro ${barbeiroId}.`
    );
  } catch (error) {
    if (connection) {
      await connection.rollback(); // Em caso de erro, desfaz todas as operações da transação
    }
    console.error("Erro ao agendar serviço:", error);
    throw new Error("Falha ao agendar serviço: " + error.message); // Re-lança o erro
  } finally {
    if (connection) {
      connection.release(); // Sempre libera a conexão de volta para o pool
    }
  }
}

module.exports = {
  buscarHorariosDisponiveis,
  agendarServico,
  buscarServicoPorNome,
  buscarBarbeiroPorNome,
  listarBarbeiros,
};
