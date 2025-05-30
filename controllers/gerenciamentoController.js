// gerenciamentoController.js
const pool = require("../db");

async function cancelarAgendamento(agendamentoId) {
  const connection = await pool.getConnection(); // Usa pool em vez de db
  try {
    // Inicia uma transação para garantir consistência
    await connection.beginTransaction();

    // Verifica se o agendamento existe e está ativo
    const [agendamento] = await connection.query(
      'SELECT * FROM agendamentos WHERE id = ? AND status = "ativo"',
      [agendamentoId]
    );

    if (!agendamento || agendamento.length === 0) {
      await connection.release();
      return {
        success: false,
        message: "Agendamento não encontrado ou já cancelado.",
      };
    }

    // Atualiza o status do agendamento para 'cancelado'
    await connection.query(
      'UPDATE agendamentos SET status = "cancelado" WHERE id = ?',
      [agendamentoId]
    );

    // Libera o horário associado (torna disponível novamente)
    await connection.query(
      "UPDATE horarios_disponiveis SET disponivel = TRUE WHERE id = ?",
      [agendamento[0].horario_id] // Ajuste para acessar o primeiro elemento
    );

    // Confirma a transação
    await connection.commit();
    await connection.release();
    return { success: true };
  } catch (error) {
    await connection.rollback(); // Desfaz a transação em caso de erro
    await connection.release();
    console.error("Erro em cancelarAgendamento:", error);
    return {
      success: false,
      message: "Erro interno ao cancelar o agendamento.",
    };
  }
}

// Resto do arquivo permanece igual
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
