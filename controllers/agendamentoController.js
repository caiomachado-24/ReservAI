const pool = require("../db");

async function buscarHorariosDisponiveis() {
  try {
    const [rows] = await pool.query(
      `SELECT id, dia_horario, dia_semana 
       FROM horarios_disponiveis 
       WHERE disponivel = TRUE 
       AND dia_horario >= NOW()
       ORDER BY dia_horario`
    );
    return rows;
  } catch (error) {
    console.error("Erro ao buscar horários disponíveis:", error);
    throw new Error("Erro ao buscar horários disponíveis.");
  }
}

async function agendarServico(clienteId, horarioId, servicoIds) {
  try {
    // Validate inputs
    if (!clienteId || !horarioId) {
      return { success: false, message: "Cliente ou horário inválido." };
    }
    if (!Array.isArray(servicoIds) || servicoIds.length === 0) {
      return { success: false, message: "Nenhum serviço selecionado." };
    }

    await pool.query("START TRANSACTION");

    // Verificar se o horário está disponível
    const [horario] = await pool.query(
      "SELECT disponivel FROM horarios_disponiveis WHERE id = ?",
      [horarioId]
    );
    if (!horario.length || !horario[0].disponivel) {
      await pool.query("ROLLBACK");
      return { success: false, message: "Horário indisponível." };
    }

    // Criar o agendamento
    const [result] = await pool.query(
      `INSERT INTO agendamentos (cliente_id, horario_id, status, data_agendamento) 
       VALUES (?, ?, 'ativo', NOW())`,
      [clienteId, horarioId]
    );
    const agendamentoId = result.insertId;

    // Associar serviços ao agendamento
    for (const servicoId of servicoIds) {
      await pool.query(
        `INSERT INTO agendamentos_servicos (agendamento_id, servico_id) 
         VALUES (?, ?)`,
        [agendamentoId, servicoId]
      );
    }

    // Marcar horário como indisponível
    await pool.query(
      "UPDATE horarios_disponiveis SET disponivel = FALSE WHERE id = ?",
      [horarioId]
    );

    await pool.query("COMMIT");
    return { success: true };
  } catch (error) {
    await pool.query("ROLLBACK");
    console.error("Erro ao agendar serviço:", error);
    return {
      success: false,
      message: "Ops, algo deu errado ao agendar. Tente novamente.",
    };
  }
}

module.exports = { buscarHorariosDisponiveis, agendarServico };
