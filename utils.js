function formatarDataHorarioBr(dateString) {
  const date = new Date(dateString);
  const opcoes = {
    weekday: "long",
    day: "numeric",
    month: "long",
    hour: "2-digit",
    minute: "2-digit",
  };

  return new Intl.DateTimeFormat("pt-BR", opcoes).format(date);
}
