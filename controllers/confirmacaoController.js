// const pool = require("../db");

// // Função para confirmar o agendamento, verificando se o horário ainda está disponível
// async function confirmarAgendamento(clienteId, servicoId, dia, hora) {
//   try {
//     // 1. Buscar ID do horário com base no dia e hora
//     const [horarios] = await pool.query(
//       "SELECT id FROM horarios_disponiveis WHERE dia_semana = ? AND TIME(dia_horario) = ?",
//       [dia, hora]
//     );

//     if (horarios.length === 0) {
//       return {
//         status: "erro",
//         mensagem: "Horário não encontrado. Verifique e tente novamente.",
//       };
//     }

//     const horarioId = horarios[0].id;

//     // 2. Verificar se o horário já está ocupado para este serviço
//     const [ocupado] = await pool.query(
//       "SELECT * FROM agendamentos WHERE horario_id = ?",
//       [horarioId]
//     );

//     if (ocupado.length > 0) {
//       return {
//         status: "ocupado",
//         mensagem:
//           "Esse horário já foi agendado por outro cliente. Por favor, escolha outro.",
//       };
//     }

//     // 3. Inserir agendamento
//     await pool.query(
//       "INSERT INTO agendamentos (cliente_id, servico_id, horario_id) VALUES (?, ?, ?)",
//       [clienteId, servicoId, horarioId]
//     );

//     return {
//       status: "ok",
//       mensagem: `✅ Agendamento confirmado para ${dia} às ${hora}!`,
//     };
//   } catch (error) {
//     console.error("Erro ao confirmar agendamento:", error);
//     return {
//       status: "erro",
//       mensagem: "Erro ao confirmar o agendamento. Tente novamente mais tarde.",
//     };
//   }
// }

// module.exports = { confirmarAgendamento };
