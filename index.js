const express = require("express");
const bodyParser = require("body-parser");
const dialogflow = require("@google-cloud/dialogflow");
const {
  buscarHorariosDisponiveis,
  agendarServico,
} = require("./controllers/agendamentoController");
const {
  encontrarOuCriarCliente,
  atualizarNomeCliente, // Embora não esteja sendo usada diretamente, mantive caso seja útil em outro ponto.
} = require("./controllers/clienteController");
const {
  listarAgendamentosAtivos,
  cancelarAgendamento, // Embora não esteja sendo usada diretamente, mantive caso seja útil em outro ponto.
  reagendarAgendamento,
} = require("./controllers/gerenciamentoController");
const pool = require("./db"); // Importe o pool de conexão do banco de dados

const app = express();
const port = 3000;

// Configuração do Dialogflow
const sessionClient = new dialogflow.SessionsClient({
  keyFilename: "./reservai_twilio.json",
});
const projectId = "reservai-twilio-qrps";

// Map para armazenar agendamentos pendentes por sessionId (from)
// Usar 'from' como chave é adequado para identificar sessões de usuário.
const agendamentosPendentes = new Map();

// Middlewares
app.use(bodyParser.urlencoded({ extended: false }));
app.use(bodyParser.json());

// --- Funções Auxiliares ---
/**
 * Formata um objeto Date para uma string legível em português.
 * Ex: "Sexta-feira, 17/05/2024 às 10:30"
 * @param {Date|string} dia_horario - A data/hora a ser formatada.
 * @returns {string} A data/hora formatada.
 */
function formatarData(dia_horario) {
  const data = new Date(dia_horario);
  if (isNaN(data.getTime())) {
    console.error("Data inválida fornecida para formatarData:", dia_horario);
    return "Data inválida"; // Retorna uma string de erro ou lida de outra forma
  }

  const options = {
    weekday: "long",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  };
  // Usar toLocaleString diretamente é mais conciso e robusto para formatação de data.
  const formattedDate = new Intl.DateTimeFormat("pt-BR", options).format(data);

  // Capitaliza a primeira letra do dia da semana
  return formattedDate.charAt(0).toUpperCase() + formattedDate.slice(1);
}

/**
 * Encontra o horário disponível mais próximo de um horário solicitado.
 * @param {string} horarioSolicitadoStr - A string de data/hora solicitada.
 * @param {Array<Object>} horariosDisponiveis - Lista de objetos de horários disponíveis, cada um com 'dia_horario' (string ou Date).
 * @returns {Object|null} O objeto do horário mais próximo ou null se não houver.
 */
function encontrarHorarioProximo(horarioSolicitadoStr, horariosDisponiveis) {
  if (!horarioSolicitadoStr || !horariosDisponiveis.length) return null;
  const solicitado = new Date(horarioSolicitadoStr);
  if (isNaN(solicitado.getTime())) return null;

  return horariosDisponiveis.reduce(
    (maisProximo, horario) => {
      const disponivel = new Date(horario.dia_horario);
      if (isNaN(disponivel.getTime())) return maisProximo; // Ignora horários inválidos na lista
      const diferenca = Math.abs(solicitado - disponivel);
      if (diferenca < maisProximo.diferenca) {
        return { horario, diferenca };
      }
      return maisProximo;
    },
    { horario: null, diferenca: Infinity }
  ).horario;
}

/**
 * Normaliza o nome de um serviço para comparação.
 * @param {string} servicoNome - O nome do serviço a ser normalizado.
 * @returns {string} O nome do serviço normalizado.
 */
function normalizarServico(servicoNome) {
  return servicoNome.toLowerCase().replace(/\s+/g, "");
}

/**
 * Mapeamento de serviços válidos e seus IDs.
 */
const SERVICOS_VALIDOS = {
  corte: { id: 1, nome: "Corte" },
  cortarcabelo: { id: 1, nome: "Corte" },
  barba: { id: 2, nome: "Barba" },
  fazerbarba: { id: 2, nome: "Barba" },
  sobrancelha: { id: 3, nome: "Sobrancelha" },
  fazersobrancelha: { id: 3, nome: "Sobrancelha" },
};

/**
 * Obtém a data de uma string de dia da semana e hora.
 * @param {string} diaSemanaStr - O dia da semana (ex: 'segunda').
 * @param {string} horaStr - A string da hora (ex: '10:00').
 * @returns {Date|null} Objeto Date correspondente ou null se inválido.
 */
function getDateFromWeekdayAndTime(diaSemanaStr, horaStr) {
  const diasDaSemana = [
    "domingo",
    "segunda-feira",
    "terça-feira",
    "quarta-feira",
    "quinta-feira",
    "sexta-feira",
    "sábado",
  ];
  const diaSemanaIndex = diasDaSemana.findIndex((d) =>
    d.includes(diaSemanaStr.replace("-feira", ""))
  );
  if (diaSemanaIndex === -1) return null;

  const [hora, minuto = "00"] = horaStr.split(":");
  const hoje = new Date();
  let data = new Date(hoje);

  // Calcula a diferença de dias para o próximo dia da semana desejado
  const diferencaDias = (diaSemanaIndex - hoje.getDay() + 7) % 7;
  data.setDate(hoje.getDate() + diferencaDias);

  data.setHours(parseInt(hora, 10), parseInt(minuto, 10), 0, 0);

  // Se a data e hora calculadas forem no passado, avança uma semana
  if (data < hoje && diferencaDias === 0) {
    // Considera apenas se for o mesmo dia da semana e a hora já passou
    data.setDate(data.getDate() + 7);
  }

  return data;
}

// --- Rota Principal do Webhook ---
app.post("/webhook", async (req, res) => {
  const msg = req.body.Body || req.body.text; // Flexibilidade para diferentes payloads (Twilio, etc.)
  const from = req.body.From || req.body.sessionId; // Identificador único do usuário

  if (!msg || !from) {
    console.error("Requisição webhook inválida: 'Body' ou 'From' ausentes.");
    return res.status(400).send("Requisição inválida.");
  }

  const sessionId = from;
  const sessionPath = sessionClient.projectAgentSessionPath(
    projectId,
    sessionId
  );
  const request = {
    session: sessionPath,
    queryInput: {
      text: { text: msg, languageCode: "pt-BR" },
    },
  };

  let resposta = ""; // Variável para armazenar a resposta a ser enviada
  try {
    const [response] = await sessionClient.detectIntent(request);
    const result = response.queryResult;
    let intent = result.intent?.displayName || "default"; // Intent detectada pelo Dialogflow
    const parametros = result.parameters?.fields || {}; // Parâmetros extraídos

    console.log("--- Nova Requisição ---");
    console.log("Mensagem do usuário:", msg);
    console.log("Intent detectada:", intent);
    console.log("Parâmetros recebidos:", JSON.stringify(parametros, null, 2));
    console.log(
      "Estado atual:",
      agendamentosPendentes.get(from) || "Nenhum estado"
    );

    // Lógica para redirecionar intents 'default' com base no estado do agendamento pendente
    const estadoAgendamentoPendente = agendamentosPendentes.get(from);
    if (intent === "default" && estadoAgendamentoPendente) {
      if (
        estadoAgendamentoPendente.confirmationStep ===
        "awaiting_reagendamento_datahora"
      ) {
        intent = "escolha_datahora_reagendamento";
      } else if (
        estadoAgendamentoPendente.confirmationStep ===
          "awaiting_name_confirmation" &&
        ["sim", "confirmar", "pode agendar"].some((k) =>
          msg.toLowerCase().includes(k)
        )
      ) {
        intent = "confirmar_agendamento";
      } else if (
        estadoAgendamentoPendente.confirmationStep ===
          "confirmar_inicio_reagendamento" &&
        ["sim", "confirmar", "quero continuar"].some((k) =>
          msg.toLowerCase().includes(k)
        )
      ) {
        intent = "confirmar_inicio_reagendamento";
      } else if (
        estadoAgendamentoPendente.confirmationStep ===
          "awaiting_reagendamento_confirmation" &&
        ["sim", "confirmar"].some((k) => msg.toLowerCase().includes(k))
      ) {
        intent = "confirmar_reagendamento";
      } else if (
        estadoAgendamentoPendente.confirmationStep ===
          "confirmar_horario_proximo" &&
        ["sim", "confirmar"].some((k) => msg.toLowerCase().includes(k))
      ) {
        intent = "confirmar_horario_proximo";
      } else if (
        estadoAgendamentoPendente.confirmationStep === "awaiting_new_name"
      ) {
        // Se estiver aguardando um novo nome e a mensagem não for uma confirmação, assume que é o novo nome.
        // Adicionar um tratamento mais específico para o novo nome aqui, talvez com uma nova intent ou sub-caso.
        intent = "atualizar_nome_cliente"; // Nova intent para tratar a atualização do nome
      }
    }

    // --- Lógica de Negócio Baseada na Intent ---
    switch (intent) {
      case "welcome_intent":
        resposta =
          "Opa, seja bem-vindo à Barbearia!\nQual serviço deseja agendar? (Corte, Barba, ou Sobrancelha)";
        agendamentosPendentes.delete(from); // Limpa qualquer estado pendente ao iniciar
        break;

      case "escolha_servico": {
        const servicoNome = parametros?.servico?.stringValue;
        if (!servicoNome) {
          resposta =
            "Não entendi qual serviço você deseja. Escolha entre Corte, Barba ou Sobrancelha.";
          break;
        }

        const servicoNormalizado = normalizarServico(servicoNome);
        const servicoInfo = SERVICOS_VALIDOS[servicoNormalizado];

        if (!servicoInfo) {
          resposta = `Desculpe, o serviço "${servicoNome}" não foi reconhecido. Escolha entre Corte, Barba ou Sobrancelha.`;
          break;
        }

        // Inicializa ou recupera o estado de agendamento pendente
        let agendamentoPendente = agendamentosPendentes.get(from) || {
          servicos: [],
          servicoIds: [],
          confirmationStep: "initial",
        };

        // Adiciona o serviço se ainda não estiver na lista
        if (!agendamentoPendente.servicos.includes(servicoInfo.nome)) {
          agendamentoPendente.servicos.push(servicoInfo.nome);
          agendamentoPendente.servicoIds = Array.isArray(
            agendamentoPendente.servicoIds
          )
            ? agendamentoPendente.servicoIds
            : [];
          agendamentoPendente.servicoIds.push(servicoInfo.id);
        }

        const horarios = await buscarHorariosDisponiveis();
        if (!horarios.length) {
          resposta =
            "Não temos horários disponíveis no momento. Tente novamente mais tarde!";
          agendamentosPendentes.delete(from);
          break;
        }

        resposta = `Ótimo! Você escolheu *${agendamentoPendente.servicos.join(
          " e "
        )}*. Horários disponíveis:\n\n${horarios
          .map((h, index) => `${index + 1}. *${formatarData(h.dia_horario)}*`)
          .join(
            "\n"
          )}\n\nDigite o número do horário desejado ou informe um dia e horário (exemplo: Sexta 10:00).`;
        agendamentoPendente.confirmationStep = "awaiting_date_time";
        agendamentosPendentes.set(from, agendamentoPendente);
        break;
      }

      case "escolha_datahora": {
        const agendamentoPendente = agendamentosPendentes.get(from);
        if (
          !agendamentoPendente ||
          !agendamentoPendente.servicos.length ||
          !Array.isArray(agendamentoPendente.servicoIds) ||
          !agendamentoPendente.servicoIds.length
        ) {
          resposta =
            "Escolha um serviço antes (Corte, Barba ou Sobrancelha). Qual prefere?";
          agendamentosPendentes.delete(from);
          break;
        }

        const horarios = await buscarHorariosDisponiveis();
        if (!horarios.length) {
          resposta =
            "Não temos horários disponíveis no momento. Tente novamente mais tarde!";
          agendamentosPendentes.delete(from);
          break;
        }

        let horarioId, diaHorario;
        const escolhaNumero = parseInt(msg) - 1; // Ajusta para índice 0
        let dataSolicitada = null;

        if (!isNaN(escolhaNumero) && horarios[escolhaNumero]) {
          // Se o usuário digitou um número da lista
          horarioId = horarios[escolhaNumero].id;
          diaHorario = horarios[escolhaNumero].dia_horario;
        } else {
          // Tenta extrair a data/hora da mensagem de texto livre
          const diaSemanaMatch = msg
            .toLowerCase()
            .match(/(segunda|terça|quarta|quinta|sexta|sábado|domingo)/);
          const horaMatch = msg.match(
            /\d{1,2}(?::\d{2})?(?:\s*(?:h|horas?|às))?/i
          );

          if (diaSemanaMatch && horaMatch) {
            dataSolicitada = getDateFromWeekdayAndTime(
              diaSemanaMatch[0],
              horaMatch[0].replace(/h|horas?|às/i, "").trim()
            );
          } else if (parametros?.["date-time"]?.stringValue) {
            // Se o Dialogflow já extraiu uma data/hora
            dataSolicitada = new Date(parametros["date-time"].stringValue);
          } else if (msg.match(/\d{1,2}:\d{2}/)) {
            // Último recurso para hora (ex: "10:30") sem dia
            const [hora, minuto = "00"] = msg
              .match(/\d{1,2}:\d{2}/)[0]
              .split(":");
            dataSolicitada = new Date(); // Data de hoje
            dataSolicitada.setHours(
              parseInt(hora, 10),
              parseInt(minuto, 10),
              0,
              0
            );
            // Se a hora já passou hoje, tenta para o mesmo horário amanhã
            if (dataSolicitada < new Date()) {
              dataSolicitada.setDate(dataSolicitada.getDate() + 1);
            }
          }

          if (dataSolicitada && !isNaN(dataSolicitada.getTime())) {
            const diaDaSemanaFormatado = dataSolicitada
              .toLocaleDateString("pt-BR", { weekday: "long" })
              .toLowerCase();
            const horaFormatada = dataSolicitada.toLocaleTimeString("pt-BR", {
              hour: "2-digit",
              minute: "2-digit",
              hour12: false,
            });

            // Busca no banco um horário exato que corresponda à solicitação
            const [horarioRow] = await pool.query(
              `SELECT id, dia_horario
               FROM horarios_disponiveis
               WHERE LOWER(dia_semana) = ?
               AND DATE_FORMAT(dia_horario, '%H:%i') = ?
               AND disponivel = TRUE
               AND dia_horario >= NOW()
               LIMIT 1`,
              [diaDaSemanaFormatado, horaFormatada]
            );

            if (horarioRow.length) {
              horarioId = horarioRow[0].id;
              diaHorario = horarioRow[0].dia_horario;
            } else {
              // Se não encontrou um horário exato, procura o mais próximo
              const horarioMaisProximo = encontrarHorarioProximo(
                dataSolicitada.toISOString(),
                horarios
              );
              if (horarioMaisProximo) {
                resposta = `O horário *${diaDaSemanaFormatado} às ${horaFormatada}* não está disponível. O mais próximo é *${formatarData(
                  horarioMaisProproximo.dia_horario
                )}*. Deseja escolher este? Responda 'Sim' ou escolha outro horário.`;
                agendamentosPendentes.set(from, {
                  ...agendamentoPendente,
                  confirmationStep: "confirmar_horario_proximo", // Novo estado para confirmar o horário próximo
                  horarioProximoId: horarioMaisProximo.id,
                  diaHorarioProximo: horarioMaisProximo.dia_horario,
                });
                break;
              } else {
                resposta = `Nenhum horário disponível próximo a *${diaDaSemanaFormatado} às ${horaFormatada}*. Escolha outro:\n\n${horarios
                  .map(
                    (h, index) =>
                      `${index + 1}. *${formatarData(h.dia_horario)}*`
                  )
                  .join("\n")}\n\nOu use o formato 'Sexta 10:00'.`;
                break;
              }
            }
          } else {
            // Se a entrada não pôde ser interpretada como número nem como data/hora válida
            resposta = `Formato inválido. Por favor, escolha um número da lista ou informe um dia e horário (exemplo: Sexta 10:00).\n\nHorários disponíveis:\n\n${horarios
              .map(
                (h, index) => `${index + 1}. *${formatarData(h.dia_horario)}*`
              )
              .join("\n")}`;
            break;
          }
        }

        // Se chegamos aqui, temos um horárioId e diaHorario válidos
        agendamentoPendente.horarioId = horarioId;
        agendamentoPendente.dia_horario = diaHorario;

        // Encontra ou cria o cliente
        const cliente = await encontrarOuCriarCliente(from, "Cliente"); // 'Cliente' como nome padrão inicial
        agendamentoPendente.clienteId = cliente.id;

        agendamentoPendente.confirmationStep = "awaiting_name_confirmation";
        agendamentosPendentes.set(from, agendamentoPendente);

        const horarioFormatado = formatarData(diaHorario);
        resposta = `Você escolheu *${agendamentoPendente.servicos.join(
          " e "
        )}* para *${horarioFormatado}*. Confirma com o nome *${
          cliente.nome
        }*? Responda 'Sim' ou informe outro nome.`;
        break;
      }

      case "confirmar_agendamento": {
        const agendamentoPendente = agendamentosPendentes.get(from);
        if (
          !agendamentoPendente ||
          agendamentoPendente.confirmationStep !== "awaiting_name_confirmation"
        ) {
          resposta =
            "Nenhum agendamento em andamento. Quer agendar um serviço?";
          agendamentosPendentes.delete(from);
          break;
        }

        const isConfirmation = ["sim", "confirmar", "pode agendar"].some((k) =>
          msg.toLowerCase().includes(k)
        );
        const isRejection = ["não", "outro nome"].some(
          (
            k // Renomeei para isRejection para maior clareza
          ) => msg.toLowerCase().includes(k)
        );

        if (isConfirmation) {
          const result = await agendarServico(
            agendamentoPendente.clienteId,
            agendamentoPendente.horarioId,
            agendamentoPendente.servicoIds
          );

          if (!result.success) {
            resposta =
              result.message ||
              "Ops, algo deu errado ao agendar. Tente novamente.";
            agendamentosPendentes.delete(from);
            break;
          }

          const horarioFormatado = formatarData(
            agendamentoPendente.dia_horario
          );
          resposta = `✅ Agendamento confirmado para *${agendamentoPendente.servicos.join(
            " e "
          )}* em *${horarioFormatado}*!`;
          agendamentosPendentes.delete(from);
        } else if (isRejection) {
          resposta = "Ok, qual nome você gostaria de usar para o agendamento?";
          agendamentosPendentes.set(from, {
            ...agendamentoPendente,
            confirmationStep: "awaiting_new_name", // Novo estado para aguardar o novo nome
          });
        } else {
          resposta =
            "Responda 'Sim' para confirmar ou 'Não' para informar outro nome.";
        }
        break;
      }

      case "atualizar_nome_cliente": {
        const agendamentoPendente = agendamentosPendentes.get(from);
        if (
          !agendamentoPendente ||
          agendamentoPendente.confirmationStep !== "awaiting_new_name"
        ) {
          resposta =
            "Não estou esperando um nome agora. Por favor, comece o agendamento novamente.";
          agendamentosPendentes.delete(from);
          break;
        }

        const novoNome = msg.trim(); // Assume que a mensagem é o novo nome
        if (novoNome.length < 2) {
          // Validação simples do nome
          resposta =
            "Por favor, me diga um nome válido (com pelo menos 2 caracteres).";
          break;
        }

        const clienteAtualizado = await atualizarNomeCliente(
          agendamentoPendente.clienteId,
          novoNome
        );

        if (clienteAtualizado.success) {
          const horarioFormatado = formatarData(
            agendamentoPendente.dia_horario
          );
          resposta = `Nome atualizado para *${novoNome}*. Confirma o agendamento de *${agendamentoPendente.servicos.join(
            " e "
          )}* para *${horarioFormatado}*? Responda 'Sim' ou 'Não'.`;
          agendamentoPendente.confirmationStep = "awaiting_name_confirmation"; // Volta para a etapa de confirmação, mas agora com o novo nome
          agendamentosPendentes.set(from, agendamentoPendente);
        } else {
          resposta =
            "Não consegui atualizar seu nome. Por favor, tente novamente.";
        }
        break;
      }

      case "reagendar_agendamento": {
        const cliente = await encontrarOuCriarCliente(from, "Cliente");
        let agendamentosAtivos;
        try {
          agendamentosAtivos = await listarAgendamentosAtivos(cliente.id);
        } catch (error) {
          console.error("Erro ao listar agendamentos:", error);
          resposta =
            "Ops, não conseguimos verificar seus agendamentos. Tente novamente mais tarde.";
          agendamentosPendentes.delete(from);
          break;
        }

        if (!agendamentosAtivos.length) {
          resposta = "Você não tem agendamentos ativos para reagendar.";
          agendamentosPendentes.delete(from);
          break;
        }

        if (agendamentosAtivos.length === 1) {
          const agendamento = agendamentosAtivos[0];
          const horarioFormatado = formatarData(agendamento.dia_horario);
          resposta = `Você tem um agendamento para *${agendamento.servico}* em *${horarioFormatado}*. Deseja reagendar? Responda 'Sim' ou 'Não'.`;
          agendamentosPendentes.set(from, {
            clienteId: cliente.id,
            agendamentoId: agendamento.id,
            servico: agendamento.servico, // Mantém o serviço para referência futura
            confirmationStep: "confirmar_inicio_reagendamento",
          });
        } else {
          resposta = `Você tem ${agendamentosAtivos.length} agendamentos ativos. Qual deseja reagendar?\n\n`;
          agendamentosAtivos.forEach((agendamento, index) => {
            const horarioFormatado = formatarData(agendamento.dia_horario);
            resposta += `${index + 1}. *${
              agendamento.servico
            }* em *${horarioFormatado}*\n`;
          });
          resposta += `\nDigite o número do agendamento (exemplo: 1).`;
          agendamentosPendentes.set(from, {
            clienteId: cliente.id,
            agendamentosAtivos, // Armazena a lista para referência
            confirmationStep: "selecionar_reagendamento",
          });
        }
        break;
      }

      case "selecionar_reagendamento": {
        const agendamentoPendente = agendamentosPendentes.get(from);
        if (
          !agendamentoPendente ||
          agendamentoPendente.confirmationStep !== "selecionar_reagendamento" ||
          !agendamentoPendente.agendamentosAtivos
        ) {
          resposta =
            "Nenhum reagendamento em andamento. Quer reagendar um agendamento?";
          agendamentosPendentes.delete(from);
          break;
        }

        const escolhaNumero = parseInt(msg) - 1;
        const agendamentoEscolhido =
          agendamentoPendente.agendamentosAtivos[escolhaNumero];

        if (!isNaN(escolhaNumero) && agendamentoEscolhido) {
          const horarios = await buscarHorariosDisponiveis();
          if (!horarios.length) {
            resposta =
              "Não temos horários disponíveis no momento. Tente novamente mais tarde!";
            agendamentosPendentes.delete(from);
            break;
          }

          resposta = `Beleza! Você escolheu reagendar o agendamento de *${
            agendamentoEscolhido.servico
          }* em *${formatarData(
            agendamentoEscolhido.dia_horario
          )}*. Escolha um novo horário:\n\n${horarios
            .map((h, index) => `${index + 1}. *${formatarData(h.dia_horario)}*`)
            .join(
              "\n"
            )}\n\nDigite o número do horário ou informe um dia e horário (exemplo: Sexta 10:00).`;

          agendamentosPendentes.set(from, {
            ...agendamentoPendente,
            agendamentoId: agendamentoEscolhido.id,
            servico: agendamentoEscolhido.servico,
            confirmationStep: "awaiting_reagendamento_datahora",
            agendamentosAtivos: undefined, // Limpa a lista de agendamentos após a seleção
          });
        } else {
          resposta = `Escolha um número válido do agendamento que deseja reagendar.`;
        }
        break;
      }

      case "confirmar_inicio_reagendamento": {
        const agendamentoPendente = agendamentosPendentes.get(from);
        if (
          !agendamentoPendente ||
          agendamentoPendente.confirmationStep !==
            "confirmar_inicio_reagendamento"
        ) {
          resposta =
            "Nenhum reagendamento em andamento. Quer reagendar um agendamento?";
          agendamentosPendentes.delete(from);
          break;
        }

        const isConfirmation = ["sim", "confirmar", "quero continuar"].some(
          (k) => msg.toLowerCase().includes(k)
        );

        if (isConfirmation) {
          const horarios = await buscarHorariosDisponiveis();
          if (!horarios.length) {
            resposta =
              "Não temos horários disponíveis no momento. Tente novamente mais tarde!";
            agendamentosPendentes.delete(from);
            break;
          }

          resposta = `Beleza! Escolha um novo horário:\n\n${horarios
            .map((h, index) => `${index + 1}. *${formatarData(h.dia_horario)}*`)
            .join(
              "\n"
            )}\n\nDigite o número do horário ou informe um dia e horário (exemplo: Sexta 10:00).`;
          agendamentoPendente.confirmationStep =
            "awaiting_reagendamento_datahora";
          agendamentosPendentes.set(from, agendamentoPendente);
        } else {
          resposta = "Reagendamento cancelado. Deseja fazer algo mais?";
          agendamentosPendentes.delete(from);
        }
        break;
      }

      case "escolha_datahora_reagendamento": {
        const agendamentoPendente = agendamentosPendentes.get(from);
        if (
          !agendamentoPendente ||
          agendamentoPendente.confirmationStep !==
            "awaiting_reagendamento_datahora"
        ) {
          resposta =
            "Nenhum reagendamento em andamento. Quer reagendar um agendamento?";
          agendamentosPendentes.delete(from);
          break;
        }

        const horarios = await buscarHorariosDisponiveis();
        if (!horarios.length) {
          resposta =
            "Não temos horários disponíveis no momento. Tente novamente mais tarde!";
          agendamentosPendentes.delete(from);
          break;
        }

        let horarioId, diaHorario;
        const escolhaNumero = parseInt(msg) - 1;
        let dataSolicitada = null;

        if (!isNaN(escolhaNumero) && horarios[escolhaNumero]) {
          horarioId = horarios[escolhaNumero].id;
          diaHorario = horarios[escolhaNumero].dia_horario;
        } else {
          const diaSemanaMatch = msg
            .toLowerCase()
            .match(/(segunda|terça|quarta|quinta|sexta|sábado|domingo)/);
          const horaMatch = msg.match(
            /\d{1,2}(?::\d{2})?(?:\s*(?:h|horas?|às))?/i
          );
          const diaSemanaParam =
            parametros?.dia_semana?.stringValue?.toLowerCase();

          if ((diaSemanaMatch || diaSemanaParam) && horaMatch) {
            const diaSemanaForParse = diaSemanaParam || diaSemanaMatch[0];
            dataSolicitada = getDateFromWeekdayAndTime(
              diaSemanaForParse,
              horaMatch[0].replace(/h|horas?|às/i, "").trim()
            );
          } else if (parametros?.["date-time"]?.stringValue) {
            dataSolicitada = new Date(parametros["date-time"].stringValue);
          } else if (msg.match(/\d{1,2}:\d{2}/)) {
            const [hora, minuto = "00"] = msg
              .match(/\d{1,2}:\d{2}/)[0]
              .split(":");
            dataSolicitada = new Date();
            dataSolicitada.setHours(
              parseInt(hora, 10),
              parseInt(minuto, 10),
              0,
              0
            );
            if (dataSolicitada < new Date()) {
              dataSolicitada.setDate(dataSolicitada.getDate() + 1);
            }
          }

          if (dataSolicitada && !isNaN(dataSolicitada.getTime())) {
            const diaDaSemanaFormatado = dataSolicitada
              .toLocaleDateString("pt-BR", { weekday: "long" })
              .toLowerCase();
            const horaFormatada = dataSolicitada.toLocaleTimeString("pt-BR", {
              hour: "2-digit",
              minute: "2-digit",
              hour12: false,
            });

            const [horarioRow] = await pool.query(
              `SELECT id, dia_horario
               FROM horarios_disponiveis
               WHERE LOWER(dia_semana) = ?
               AND DATE_FORMAT(dia_horario, '%H:%i') = ?
               AND disponivel = TRUE
               AND dia_horario >= NOW()
               LIMIT 1`,
              [diaDaSemanaFormatado, horaFormatada]
            );

            if (horarioRow.length) {
              horarioId = horarioRow[0].id;
              diaHorario = horarioRow[0].dia_horario;
            } else {
              const horarioMaisProximo = encontrarHorarioProximo(
                dataSolicitada.toISOString(),
                horarios
              );
              if (horarioMaisProximo) {
                resposta = `O horário *${diaDaSemanaFormatado} às ${horaFormatada}* não está disponível. O mais próximo é *${formatarData(
                  horarioMaisProximo.dia_horario
                )}*. Deseja escolher este? Responda 'Sim' ou escolha outro horário.`;
                agendamentosPendentes.set(from, {
                  ...agendamentoPendente,
                  confirmationStep: "confirmar_horario_proximo",
                  horarioProximoId: horarioMaisProximo.id,
                  diaHorarioProximo: horarioMaisProximo.dia_horario,
                });
                break;
              } else {
                resposta = `Nenhum horário disponível próximo a *${diaDaSemanaFormatado} às ${horaFormatada}*. Escolha outro:\n\n${horarios
                  .map(
                    (h, index) =>
                      `${index + 1}. *${formatarData(h.dia_horario)}*`
                  )
                  .join("\n")}\n\nOu use o formato 'Sexta 10:00'.`;
                break;
              }
            }
          } else {
            resposta = `Formato inválido. Escolha um horário da lista:\n\n${horarios
              .map(
                (h, index) => `${index + 1}. *${formatarData(h.dia_horario)}*`
              )
              .join("\n")}\n\nOu use o formato 'Sexta 10:00'.`;
            break;
          }
        }

        agendamentoPendente.horarioId = horarioId;
        agendamentoPendente.dia_horario = diaHorario;
        agendamentoPendente.confirmationStep =
          "awaiting_reagendamento_confirmation";
        agendamentosPendentes.set(from, agendamentoPendente);

        const horarioFormatado = formatarData(diaHorario);
        resposta = `Você escolheu reagendar *${agendamentoPendente.servico}* para *${horarioFormatado}*. Confirma? Responda 'Sim' ou 'Não'.`;
        break;
      }

      case "confirmar_reagendamento": {
        const agendamentoPendente = agendamentosPendentes.get(from);
        if (
          !agendamentoPendente ||
          agendamentoPendente.confirmationStep !==
            "awaiting_reagendamento_confirmation"
        ) {
          resposta =
            "Nenhum reagendamento em andamento. Quer reagendar um agendamento?";
          agendamentosPendentes.delete(from);
          break;
        }

        const isConfirmation = ["sim", "confirmar"].some((k) =>
          msg.toLowerCase().includes(k)
        );

        if (isConfirmation) {
          const result = await reagendarAgendamento(
            agendamentoPendente.agendamentoId,
            agendamentoPendente.horarioId
          );

          if (!result.success) {
            resposta =
              result.message ||
              "Ops, algo deu errado ao reagendar. Tente novamente.";
            agendamentosPendentes.delete(from);
            break;
          }

          const horarioFormatado = formatarData(
            agendamentoPendente.dia_horario
          );
          resposta = `✅ Agendamento reagendado para *${agendamentoPendente.servico}* em *${horarioFormatado}*!`;
          agendamentosPendentes.delete(from);
        } else {
          resposta = "Reagendamento cancelado. Deseja escolher outro horário?";
          agendamentoPendente.confirmationStep =
            "awaiting_reagendamento_datahora"; // Volta para a escolha de horário
          agendamentosPendentes.set(from, agendamentoPendente);
        }
        break;
      }

      case "confirmar_horario_proximo": {
        const agendamentoPendente = agendamentosPendentes.get(from);
        if (
          !agendamentoPendente ||
          agendamentoPendente.confirmationStep !==
            "confirmar_horario_proximo" ||
          !agendamentoPendente.horarioProximoId // Garante que há um horário próximo para confirmar
        ) {
          resposta =
            "Nenhuma sugestão de horário próximo para confirmar. Por favor, tente novamente.";
          agendamentosPendentes.delete(from);
          break;
        }

        const isConfirmation = ["sim", "confirmar"].some((k) =>
          msg.toLowerCase().includes(k)
        );

        if (isConfirmation) {
          // Usa o horário próximo sugerido
          agendamentoPendente.horarioId = agendamentoPendente.horarioProximoId;
          agendamentoPendente.dia_horario =
            agendamentoPendente.diaHorarioProximo;

          // Redireciona para a confirmação final, seja de agendamento ou reagendamento
          if (agendamentoPendente.agendamentoId) {
            // Se for um reagendamento
            agendamentoPendente.confirmationStep =
              "awaiting_reagendamento_confirmation";
            const horarioFormatado = formatarData(
              agendamentoPendente.dia_horario
            );
            resposta = `Você escolheu reagendar *${agendamentoPendente.servico}* para *${horarioFormatado}*. Confirma? Responda 'Sim' ou 'Não'.`;
          } else {
            // Se for um novo agendamento
            agendamentoPendente.confirmationStep = "awaiting_name_confirmation";
            const cliente = await encontrarOuCriarCliente(from, "Cliente");
            const horarioFormatado = formatarData(
              agendamentoPendente.dia_horario
            );
            resposta = `Você escolheu *${agendamentoPendente.servicos.join(
              " e "
            )}* para *${horarioFormatado}*. Confirma com o nome *${
              cliente.nome
            }*? Responda 'Sim' ou informe outro nome.`;
          }
          agendamentosPendentes.set(from, agendamentoPendente);
        } else {
          // Usuário recusou o horário próximo, pede para escolher outro
          const horarios = await buscarHorariosDisponiveis();
          resposta = `Ok, escolha outro horário:\n\n${horarios
            .map((h, index) => `${index + 1}. *${formatarData(h.dia_horario)}*`)
            .join(
              "\n"
            )}\n\nDigite o número do horário ou informe um dia e horário (exemplo: Sexta 10:00).`;

          // Dependendo do fluxo, volta para a escolha de data/hora relevante
          agendamentoPendente.confirmationStep =
            agendamentoPendente.agendamentoId
              ? "awaiting_reagendamento_datahora"
              : "awaiting_date_time";
          delete agendamentoPendente.horarioProximoId; // Limpa o estado do horário próximo
          delete agendamentoPendente.diaHorarioProximo;
          agendamentosPendentes.set(from, agendamentoPendente);
        }
        break;
      }

      // Adicionei um caso para "cancelar_agendamento" para completar o fluxo comum
      case "cancelar_agendamento": {
        const cliente = await encontrarOuCriarCliente(from, "Cliente");
        let agendamentosAtivos;
        try {
          agendamentosAtivos = await listarAgendamentosAtivos(cliente.id);
        } catch (error) {
          console.error(
            "Erro ao listar agendamentos para cancelamento:",
            error
          );
          resposta =
            "Ops, não conseguimos verificar seus agendamentos para cancelar. Tente novamente mais tarde.";
          agendamentosPendentes.delete(from);
          break;
        }

        if (!agendamentosAtivos.length) {
          resposta = "Você não tem agendamentos ativos para cancelar.";
          agendamentosPendentes.delete(from);
          break;
        }

        if (agendamentosAtivos.length === 1) {
          const agendamento = agendamentosAtivos[0];
          const horarioFormatado = formatarData(agendamento.dia_horario);
          resposta = `Você tem um agendamento para *${agendamento.servico}* em *${horarioFormatado}*. Deseja cancelar? Responda 'Sim' ou 'Não'.`;
          agendamentosPendentes.set(from, {
            clienteId: cliente.id,
            agendamentoId: agendamento.id,
            servico: agendamento.servico,
            confirmationStep: "confirmar_cancelamento",
          });
        } else {
          resposta = `Você tem ${agendamentosAtivos.length} agendamentos ativos. Qual deseja cancelar?\n\n`;
          agendamentosAtivos.forEach((agendamento, index) => {
            const horarioFormatado = formatarData(agendamento.dia_horario);
            resposta += `${index + 1}. *${
              agendamento.servico
            }* em *${horarioFormatado}*\n`;
          });
          resposta += `\nDigite o número do agendamento (exemplo: 1).`;
          agendamentosPendentes.set(from, {
            clienteId: cliente.id,
            agendamentosAtivos,
            confirmationStep: "selecionar_cancelamento",
          });
        }
        break;
      }

      case "selecionar_cancelamento": {
        const agendamentoPendente = agendamentosPendentes.get(from);
        if (
          !agendamentoPendente ||
          agendamentoPendente.confirmationStep !== "selecionar_cancelamento" ||
          !agendamentoPendente.agendamentosAtivos
        ) {
          resposta =
            "Nenhum cancelamento em andamento. Quer cancelar um agendamento?";
          agendamentosPendentes.delete(from);
          break;
        }

        const escolhaNumero = parseInt(msg) - 1;
        const agendamentoEscolhido =
          agendamentoPendente.agendamentosAtivos[escolhaNumero];

        if (!isNaN(escolhaNumero) && agendamentoEscolhido) {
          const horarioFormatado = formatarData(
            agendamentoEscolhido.dia_horario
          );
          resposta = `Você escolheu cancelar o agendamento de *${agendamentoEscolhido.servico}* em *${horarioFormatado}*. Confirma o cancelamento? Responda 'Sim' ou 'Não'.`;
          agendamentosPendentes.set(from, {
            ...agendamentoPendente,
            agendamentoId: agendamentoEscolhido.id,
            servico: agendamentoEscolhido.servico,
            confirmationStep: "confirmar_cancelamento",
            agendamentosAtivos: undefined,
          });
        } else {
          resposta = `Escolha um número válido do agendamento que deseja cancelar.`;
        }
        break;
      }

      case "confirmar_cancelamento": {
        const agendamentoPendente = agendamentosPendentes.get(from);
        if (
          !agendamentoPendente ||
          agendamentoPendente.confirmationStep !== "confirmar_cancelamento"
        ) {
          resposta =
            "Nenhum cancelamento em andamento. Quer cancelar um agendamento?";
          agendamentosPendentes.delete(from);
          break;
        }

        const isConfirmation = ["sim", "confirmar"].some((k) =>
          msg.toLowerCase().includes(k)
        );

        if (isConfirmation) {
          const result = await cancelarAgendamento(
            agendamentoPendente.agendamentoId
          );

          if (!result.success) {
            resposta =
              result.message ||
              "Ops, algo deu errado ao cancelar. Tente novamente.";
            agendamentosPendentes.delete(from);
            break;
          }

          resposta = `✅ Agendamento de *${agendamentoPendente.servico}* cancelado com sucesso!`;
          agendamentosPendentes.delete(from);
        } else {
          resposta = "Cancelamento não confirmado. Deseja fazer algo mais?";
          agendamentosPendentes.delete(from);
        }
        break;
      }

      default:
        // Mensagem padrão caso a intent não seja reconhecida ou tratada
        resposta =
          result.fulfillmentText ||
          "Desculpe, não entendi. Pode repetir, por favor?";
        agendamentosPendentes.delete(from); // Limpa o estado para evitar loops indesejados
        break;
    }

    console.log("Resposta enviada:", resposta);
    res.json({ reply: resposta }); // Envia a resposta de volta
  } catch (error) {
    console.error("Erro no Dialogflow ou webhook:", error);
    res.json({ reply: "Ops, algo deu errado. Tente novamente?" });
  }
});

app.listen(port, () => {
  console.log(`🚀 Servidor rodando em http://localhost:${port}`);
});
