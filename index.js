// index.js
const express = require("express");
const bodyParser = require("body-parser");
const dialogflow = require("@google-cloud/dialogflow");
const {
  buscarHorariosDisponiveis,
  agendarServico,
  buscarServicoPorNome,
  buscarBarbeiroPorNome,
  listarBarbeiros,
} = require("./controllers/agendamentoController");
const { encontrarOuCriarCliente } = require("./controllers/clienteController");
const pool = require("./db"); // Importa a conexão com o banco de dados

const app = express();
const port = 3000;

// Configuração do cliente Dialogflow para autenticação e comunicação
const sessionClient = new dialogflow.SessionsClient({
  keyFilename: "./reservai_twilio.json", // Caminho para o arquivo de chave JSON do Dialogflow
});

const projectId = "reservai-twilio-qrps"; // ID do seu projeto Dialogflow

// O Map 'agendamentosPendentes' armazena o estado da conversa para cada sessão de usuário.
// Isso é crucial para gerenciar agendamentos em múltiplas etapas.
const agendamentosPendentes = new Map();

// Middleware para parsear o corpo das requisições HTTP
app.use(bodyParser.urlencoded({ extended: false }));
app.use(bodyParser.json());

/**
 * Função auxiliar para formatar objetos Date para um formato legível em português.
 * Opcionalmente, inclui o nome do barbeiro.
 * @param {Date|string} dia_horario - A data e hora (pode ser objeto Date ou string) a ser formatada.
 * @param {string} [barbeiroNome=null] - O nome do barbeiro para ser incluído na string formatada.
 * @returns {string} A string formatada da data e hora.
 */
function formatarData(dia_horario, barbeiroNome = null) {
  const data = new Date(dia_horario);
  const options = {
    weekday: "long",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false, // Formato 24 horas
  };
  const formatter = new Intl.DateTimeFormat("pt-BR", options);
  const parts = formatter.formatToParts(data);

  // Extrai as partes relevantes para montar a string
  const dia = parts.find((p) => p.type === "day").value;
  const mes = parts.find((p) => p.type === "month").value;
  const ano = parts.find((p) => p.type === "year").value;
  const hora = parts.find((p) => p.type === "hour").value;
  const minuto = parts.find((p) => p.type === "minute").value;
  const semana = parts.find((p) => p.type === "weekday").value;

  let formattedString = `📅 ${
    semana.charAt(0).toUpperCase() + semana.slice(1)
  } (${dia}/${mes}/${ano} às ${hora}:${minuto})`;
  if (barbeiroNome) {
    formattedString += ` com ${barbeiroNome}`;
  }
  return formattedString;
}

/**
 * Encontra o horário disponível mais próximo de um horário solicitado.
 * Ideal para quando o horário exato desejado pelo usuário não está disponível.
 * @param {string} horarioSolicitado - Horário no formato "HH:MM".
 * @param {Array<Object>} horariosDisponiveis - Lista de objetos de horários disponíveis.
 * @returns {Object|null} O objeto do horário mais próximo ou null se a lista estiver vazia.
 */
function encontrarHorarioProximo(horarioSolicitado, horariosDisponiveis) {
  const [hora, minuto] = horarioSolicitado.split(":").map(Number);
  const solicitado = new Date();
  // Define o ano, mês e dia para a data atual, apenas a hora e minuto importam para a comparação de proximidade
  solicitado.setHours(hora, minuto, 0, 0);

  let maisProximo = null;
  let menorDiferenca = Infinity; // Inicializa com um valor grande para encontrar a menor diferença

  for (const horario of horariosDisponiveis) {
    const disponivel = new Date(horario.dia_horario);
    const diferenca = Math.abs(solicitado - disponivel); // Diferença em milissegundos
    if (diferenca < menorDiferenca) {
      menorDiferenca = diferenca;
      maisProximo = horario;
    }
  }
  return maisProximo;
}

// --- Rota Principal do Webhook ---
app.post("/webhook", async (req, res) => {
  // Extrai a mensagem do usuário (Body para Twilio, text para outros) e o ID da sessão
  const msg = req.body.Body || req.body.text;
  const from = req.body.From || req.body.sessionId; // 'from' serve como sessionId

  // Validação básica da requisição
  if (!msg || !from) {
    console.error("Requisição webhook inválida: 'Body' ou 'From' ausentes.");
    return res.status(400).send("Requisição inválida.");
  }

  const sessionId = from; // Usa o 'from' (número do WhatsApp) como ID da sessão Dialogflow
  const sessionPath = sessionClient.projectAgentSessionPath(
    projectId,
    sessionId
  );

  // Configura a requisição para o Dialogflow
  const request = {
    session: sessionPath,
    queryInput: {
      text: {
        text: msg,
        languageCode: "pt-BR",
      },
    },
  };

  let resposta = ""; // Variável para armazenar a resposta do bot

  try {
    // Detecta a intent do usuário através do Dialogflow
    const responses = await sessionClient.detectIntent(request);
    const result = responses[0].queryResult;

    const intent = result.intent?.displayName; // Nome da intent detectada
    const parametros = result.parameters?.fields; // Parâmetros extraídos pela intent

    console.log("--- Nova Requisição ---");
    console.log("Mensagem do usuário:", msg);
    console.log("Intent detectada:", intent);
    console.log("Parâmetros recebidos:", JSON.stringify(parametros, null, 2));

    // --- Lógica de Negócios baseada na Intent Detectada ---
    switch (intent) {
      case "welcome_intent":
        // Intent de boas-vindas: apenas envia a resposta de fulfillment do Dialogflow
        resposta = result.fulfillmentText;
        break;

      case "escolha_servico":
        {
          const servicoNome = parametros?.servico?.stringValue;
          const barbeiroNome = parametros?.barbeiro?.stringValue;

          if (!servicoNome) {
            resposta = "Não entendi qual serviço você deseja. Pode repetir?";
            break;
          }

          const servico = await buscarServicoPorNome(servicoNome);
          if (!servico) {
            resposta = `Desculpe, o serviço "${servicoNome}" não é oferecido. Por favor, escolha entre Corte, Barba ou Sobrancelha.`;
            break;
          }

          // Inicializa ou recupera o objeto de agendamento pendente para a sessão
          let agendamentoPendente = agendamentosPendentes.get(from) || {
            servicos: [],
            servicoIds: [], // Garante que servicoIds é sempre um array
            confirmationStep: "initial",
            barbeiroId: null,
            barbeiroNome: null,
          };

          // Adiciona o serviço selecionado se ele ainda não estiver na lista
          if (!agendamentoPendente.servicos.includes(servico.nome)) {
            agendamentoPendente.servicos.push(servico.nome);
            agendamentoPendente.servicoIds.push(servico.id);
          }

          let barbeiro = null;
          if (barbeiroNome) {
            barbeiro = await buscarBarbeiroPorNome(barbeiroNome);
            if (!barbeiro) {
              resposta = `Desculpe, não encontrei o barbeiro "${barbeiroNome}". Por favor, escolha um barbeiro válido ou não especifique um.`;
              agendamentosPendentes.delete(from); // Cancela o fluxo se o barbeiro não existe
              break;
            }
            agendamentoPendente.barbeiroId = barbeiro.id;
            agendamentoPendente.barbeiroNome = barbeiro.nome;
          }

          // Busca horários disponíveis, filtrando pelo barbeiro se um foi especificado
          const horarios = await buscarHorariosDisponiveis(
            agendamentoPendente.barbeiroId
          );

          if (horarios.length === 0) {
            resposta =
              "Desculpe, não há horários disponíveis no momento para o(s) serviço(s) e barbeiro selecionado.";
          } else {
            resposta = `Para *${agendamentoPendente.servicos.join(" e ")}*${
              agendamentoPendente.barbeiroNome
                ? ` com ${agendamentoPendente.barbeiroNome}`
                : ""
            }, temos os seguintes horários disponíveis:\n\n`;
            resposta += horarios
              .map((h) => formatarData(h.dia_horario, h.barbeiro_nome))
              .join("\n");
            resposta += `\n\nInforme o dia e hora desejados (ex: Quarta 14:00).`;
            if (!agendamentoPendente.barbeiroNome) {
              const todosBarbeiros = await listarBarbeiros();
              if (todosBarbeiros.length > 0) {
                resposta += `\n\nVocê também pode especificar um barbeiro (ex: "Quarta 14:00 com o João"). Barbeiros disponíveis: ${todosBarbeiros
                  .map((b) => b.nome)
                  .join(", ")}.`;
              }
            }
          }
          agendamentosPendentes.set(from, agendamentoPendente);
        }
        break;

      case "escolha_datahora":
        {
          const horarioEscolhidoStruct =
            parametros?.horario_escolhido?.structValue?.fields;
          const horarioEscolhido =
            horarioEscolhidoStruct?.date_time?.stringValue;
          const barbeiroNome = parametros?.barbeiro?.stringValue;

          if (!horarioEscolhido) {
            resposta =
              "Por favor, informe o dia e hora no formato: Quarta 14:00.";
            break;
          }

          const data = new Date(horarioEscolhido);
          if (isNaN(data.getTime())) {
            resposta =
              "Não consegui entender o horário. Por favor, use o formato: Quarta 14:00.";
            break;
          }

          const dia = data.toLocaleDateString("pt-BR", { weekday: "long" });
          const hora = data.toLocaleTimeString("pt-BR", {
            hour: "2-digit",
            minute: "2-digit",
            hour12: false,
          });

          let agendamentoPendente = agendamentosPendentes.get(from) || {
            servicos: [],
            servicoIds: [],
            confirmationStep: "initial",
            barbeiroId: null,
            barbeiroNome: null,
          };
          const servicos = agendamentoPendente.servicos;
          const servicoIds = agendamentoPendente.servicoIds;

          if (
            !servicos ||
            servicos.length === 0 ||
            !servicoIds ||
            servicoIds.length === 0
          ) {
            resposta =
              "Por favor, escolha um serviço primeiro antes de informar a data e hora.";
            break;
          }

          let barbeiro = null;
          if (barbeiroNome) {
            barbeiro = await buscarBarbeiroPorNome(barbeiroNome);
            if (!barbeiro) {
              resposta = `Desculpe, não encontrei o barbeiro "${barbeiroNome}". Por favor, escolha um barbeiro válido ou não especifique um.`;
              agendamentosPendentes.delete(from);
              break;
            }
            agendamentoPendente.barbeiroId = barbeiro.id;
            agendamentoPendente.barbeiroNome = barbeiro.nome;
          }

          try {
            const cliente = await encontrarOuCriarCliente(from, "Cliente");
            agendamentoPendente.clienteId = cliente.id;

            let horarioQuery = `
              SELECT hd.id, hd.dia_horario, hd.dia_semana, hd.barbeiro_id, b.nome AS barbeiro_nome
              FROM horarios_disponiveis hd
              JOIN barbeiros b ON hd.barbeiro_id = b.id
              WHERE hd.dia_semana = ? AND TIME(hd.dia_horario) = ? AND hd.disponivel = TRUE
            `;
            let horarioQueryParams = [dia, hora];

            if (agendamentoPendente.barbeiroId) {
              horarioQuery += ` AND hd.barbeiro_id = ?`;
              horarioQueryParams.push(agendamentoPendente.barbeiroId);
            }

            const [horarioRow] = await pool.query(
              horarioQuery,
              horarioQueryParams
            );

            if (horarioRow.length === 0) {
              const horariosDisponiveis = await buscarHorariosDisponiveis(
                agendamentoPendente.barbeiroId
              );
              const horarioMaisProximo = encontrarHorarioProximo(
                hora,
                horariosDisponiveis
              );

              if (!horarioMaisProximo) {
                resposta = `Não há horários disponíveis próximos a ${dia} às ${hora}${
                  agendamentoPendente.barbeiroNome
                    ? ` com ${agendamentoPendente.barbeiroNome}`
                    : ""
                }. Tente outro dia ou horário.`;
                break;
              }

              const horarioFormatado = formatarData(
                horarioMaisProximo.dia_horario,
                horarioMaisProximo.barbeiro_nome
              );
              resposta = `Desculpe, o horário ${dia} às ${hora}${
                agendamentoPendente.barbeiroNome
                  ? ` com ${agendamentoPendente.barbeiroNome}`
                  : ""
              } não está disponível. O horário mais próximo é *${horarioFormatado}*. Gostaria de agendar seu *${servicos.join(
                " e "
              )}* para esse horário? Responda "Sim" para confirmar ou escolha outro horário.`;

              agendamentosPendentes.set(from, {
                ...agendamentoPendente,
                clienteId: cliente.id,
                servicoIds,
                horarioId: horarioMaisProximo.id,
                dia_horario: horarioMaisProximo.dia_horario,
                servicos,
                barbeiroId: horarioMaisProximo.barbeiro_id,
                barbeiroNome: horarioMaisProximo.barbeiro_nome,
                confirmationStep: "awaiting_name_confirmation",
              });
            } else {
              agendamentosPendentes.set(from, {
                ...agendamentoPendente,
                clienteId: cliente.id,
                servicoIds,
                horarioId: horarioRow[0].id,
                dia_horario: horarioRow[0].dia_horario,
                servicos,
                barbeiroId: horarioRow[0].barbeiro_id,
                barbeiroNome: horarioRow[0].barbeiro_nome,
                confirmationStep: "awaiting_name_confirmation",
              });

              const horarioFormatado = formatarData(
                agendamentosPendentes.get(from).dia_horario,
                agendamentosPendentes.get(from).barbeiroNome
              );
              resposta = `Certo, você escolheu *${horarioFormatado}* para *${servicos.join(
                " e "
              )}*.`;

              const [clienteRows] = await pool.query(
                "SELECT nome, telefone FROM clientes WHERE id = ?",
                [cliente.id]
              );
              const clienteInfo = clienteRows[0];
              if (clienteInfo) {
                // Melhoria na mensagem de confirmação do nome
                resposta += ` Antes de confirmar, posso agendar no nome de *${clienteInfo.nome}* (${clienteInfo.telefone})? Responda "Sim" para confirmar ou "Não" para outro nome.`;
              } else {
                resposta += ` Antes de confirmar, qual nome e telefone gostaria de usar para o agendamento?`;
              }
            }
          } catch (err) {
            console.error("Erro ao processar escolha_datahora:", err);
            resposta =
              "Tivemos um erro ao processar seu pedido. Tente novamente mais tarde.";
          }
        }
        break;

      case "confirmar_agendamento":
        const dadosAgendamento = agendamentosPendentes.get(from);

        if (!dadosAgendamento) {
          resposta =
            "Nenhum agendamento pendente encontrado. Por favor, comece novamente.";
          break;
        }

        const {
          clienteId,
          servicoIds,
          horarioId,
          dia_horario,
          servicos,
          barbeiroId,
          barbeiroNome,
          confirmationStep,
        } = dadosAgendamento;

        const isConfirmation =
          msg.toLowerCase().includes("sim") ||
          msg.toLowerCase().includes("confirmar");
        const isCancellation =
          msg.toLowerCase().includes("não") ||
          msg.toLowerCase().includes("cancelar");

        // --- Etapa 1: Confirmação do Nome/Telefone do Cliente ---
        if (confirmationStep === "awaiting_name_confirmation") {
          if (isConfirmation) {
            try {
              const [clienteRows] = await pool.query(
                "SELECT nome, telefone FROM clientes WHERE id = ?",
                [clienteId]
              );
              const clienteInfo = clienteRows[0];

              if (clienteInfo) {
                const horarioFormatado = formatarData(
                  dia_horario,
                  barbeiroNome
                );
                // Melhoria na mensagem de confirmação final com nome e telefone
                resposta = `Certo! Posso agendar seu *${servicos.join(
                  " e "
                )}* para *${horarioFormatado}* no nome de *${
                  clienteInfo.nome
                }* (${
                  clienteInfo.telefone
                })? Responda "Sim" para confirmar ou "Não" para cancelar.`;

                agendamentosPendentes.set(from, {
                  ...dadosAgendamento,
                  confirmationStep: "awaiting_final_booking",
                  clienteNome: clienteInfo.nome,
                  clienteTelefone: clienteInfo.telefone,
                });
              } else {
                resposta =
                  "Não foi possível encontrar os dados do cliente. Por favor, comece novamente.";
                agendamentosPendentes.delete(from);
              }
            } catch (err) {
              console.error(
                "Erro ao buscar dados do cliente para confirmação:",
                err
              );
              resposta =
                "Ocorreu um erro ao preparar a confirmação. Tente novamente.";
              agendamentosPendentes.delete(from);
            }
          } else if (isCancellation) {
            resposta = "Agendamento cancelado. Se precisar, comece novamente.";
            agendamentosPendentes.delete(from);
          } else {
            resposta =
              "Por favor, responda 'Sim' para confirmar o nome ou 'Não' para cancelar o agendamento.";
          }
          break;
        }

        // --- Etapa 2: Confirmação Final do Agendamento ---
        if (confirmationStep === "awaiting_final_booking") {
          if (isConfirmation) {
            try {
              const [horarioCheck] = await pool.query(
                "SELECT id FROM horarios_disponiveis WHERE id = ? AND disponivel = TRUE",
                [horarioId]
              );

              if (horarioCheck.length === 0) {
                resposta =
                  "Desculpe, esse horário não está mais disponível. Por favor, escolha outro.";
                agendamentosPendentes.delete(from);
                break;
              }

              await agendarServico(
                clienteId,
                servicoIds,
                horarioId,
                barbeiroId
              );

              const horarioFormatado = formatarData(dia_horario, barbeiroNome);
              // Mensagem final de sucesso com nome e telefone do cliente
              resposta = `✅ Agendado! Seu *${servicos.join(
                " e "
              )}* foi marcado para *${horarioFormatado}* em nome de *${
                dadosAgendamento.clienteNome
              }* (${dadosAgendamento.clienteTelefone}).`;
              agendamentosPendentes.delete(from);
            } catch (err) {
              console.error("Erro ao confirmar agendamento:", err);
              resposta = "Erro ao confirmar o agendamento. Tente novamente.";
            }
          } else if (isCancellation) {
            resposta = "Agendamento cancelado. Se precisar, comece novamente.";
            agendamentosPendentes.delete(from);
          } else {
            resposta =
              "Por favor, responda 'Sim' para confirmar o agendamento ou 'Não' para cancelar.";
          }
          break;
        }

        // --- Caso Padrão para 'confirmar_agendamento' (se o estado não for reconhecido) ---
        resposta =
          "Nenhum agendamento pendente ou etapa de confirmação ativa. Por favor, comece novamente.";
        agendamentosPendentes.delete(from);
        break;

      default:
        resposta = result.fulfillmentText || "Não entendi. Pode repetir?";
    }

    // --- Log da Resposta do Bot ---
    console.log("Resposta do bot:", resposta);

    // Envia a resposta de volta para a plataforma (ex: Twilio) no formato XML
    res.set("Content-Type", "text/xml");
    res.send(`<Response><Message>${resposta}</Message></Response>`);
  } catch (error) {
    console.error("Erro no Dialogflow ou no webhook:", error);
    res.set("Content-Type", "text/xml");
    res.send(
      `<Response><Message>Erro interno. Tente novamente mais tarde.</Message></Response>`
    );
  }
});

// Inicia o servidor na porta especificada
app.listen(port, () => {
  console.log(`🚀 Servidor rodando em http://localhost:${port}`);
});
