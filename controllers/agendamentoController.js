const pool = require("../db");

// Buscar horários disponíveis que ainda não foram agendados
async function buscarHorariosDisponiveis() {
  const [horarios] = await pool.query(`
   SELECT dia_horario, dia_semana FROM horarios_disponiveis ORDER BY dia_horario;
  `);
  console.log(horarios);
  return horarios;
}

// Agendar um serviço para um cliente em um horário
async function agendarServico(clienteId, servicoId, horarioId) {
  await pool.query(
    "INSERT INTO agendamentos (cliente_id, servico_id, horario_id) VALUES (?, ?, ?)",
    [clienteId, servicoId, horarioId]
  );
}

// Buscar todos os agendamentos futuros (opcional)
async function listarAgendamentosFuturos() {
  const [agendamentos] = await pool.query(`
    SELECT 
      a.id,
      c.nome AS cliente,
      s.nome AS servico,
      h.dia_horario,
      h.dia_semana
    FROM agendamentos a
    JOIN clientes c ON a.cliente_id = c.id
    JOIN servicos s ON a.servico_id = s.id
    JOIN horarios_disponiveis h ON a.horario_id = h.id
    ORDER BY h.dia_horario
  `);
  return agendamentos;
}

module.exports = {
  buscarHorariosDisponiveis,
  agendarServico,
  listarAgendamentosFuturos, // se quiser usar depois
};
