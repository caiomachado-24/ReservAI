const pool = require("../db");

async function listarAgendamentosAtivos(clienteId) {
  try {
    const [rows] = await pool.query(
      `SELECT a.id, a.horario_id, s.nome AS servico, h.dia_horario
       FROM agendamentos a
       JOIN agendamentos_servicos asv ON a.id = asv.agendamento_id
       JOIN servicos s ON asv.servico_id = s.id
       JOIN horarios_disponiveis h ON a.horario_id = h.id
       WHERE a.cliente_id = ? AND a.status = 'ativo'`,
      [clienteId]
    );
    return rows;
  } catch (error) {
    console.error("Erro ao listar agendamentos ativos:", error);
    throw new Error("Erro ao listar agendamentos ativos.");
  }
}

async function cancelarAgendamento(agendamentoId) {
  try {
    await pool.query("START TRANSACTION");

    const [agendamento] = await pool.query(
      'SELECT horario_id FROM agendamentos WHERE id = ? AND status = "ativo"',
      [agendamentoId]
    );
    if (!agendamento.length) {
      await pool.query("ROLLBACK");
      return false;
    }

    await pool.query(
      'UPDATE agendamentos SET status = "cancelado" WHERE id = ?',
      [agendamentoId]
    );

    await pool.query(
      "UPDATE horarios_disponiveis SET disponivel = TRUE WHERE id = ?",
      [agendamento[0].horario_id]
    );

    await pool.query("COMMIT");
    return true;
  } catch (error) {
    await pool.query("ROLLBACK");
    console.error("Erro ao cancelar agendamento:", error);
    return false;
  }
}

async function reagendarAgendamento(agendamentoId, novoHorarioId) {
  try {
    await pool.query("START TRANSACTION");

    const [agendamento] = await pool.query(
      'SELECT horario_id FROM agendamentos WHERE id = ? AND status = "ativo"',
      [agendamentoId]
    );
    if (!agendamento.length) {
      await pool.query("ROLLBACK");
      return {
        success: false,
        message: "Agendamento não encontrado ou já cancelado.",
      };
    }

    const [novoHorario] = await pool.query(
      "SELECT disponivel FROM horarios_disponiveis WHERE id = ?",
      [novoHorarioId]
    );
    if (!novoHorario.length || !novoHorario[0].disponivel) {
      await pool.query("ROLLBACK");
      return { success: false, message: "Novo horário indisponível." };
    }

    await pool.query("UPDATE agendamentos SET horario_id = ? WHERE id = ?", [
      novoHorarioId,
      agendamentoId,
    ]);

    await pool.query(
      "UPDATE horarios_disponiveis SET disponivel = TRUE WHERE id = ?",
      [agendamento[0].horario_id]
    );

    await pool.query(
      "UPDATE horarios_disponiveis SET disponivel = FALSE WHERE id = ?",
      [novoHorarioId]
    );

    await pool.query("COMMIT");
    return { success: true };
  } catch (error) {
    await pool.query("ROLLBACK");
    console.error("Erro ao reagendar:", error);
    return {
      success: false,
      message: "Ops, algo deu errado ao reagendar. Tente novamente.",
    };
  }
}

module.exports = {
  listarAgendamentosAtivos,
  cancelarAgendamento,
  reagendarAgendamento,
};
