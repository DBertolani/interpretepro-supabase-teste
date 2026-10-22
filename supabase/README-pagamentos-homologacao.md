# Pagamentos IntérpretePro — homologação

Este diretório contém o código-fonte das Edge Functions de pagamento. Nenhuma função foi implantada no Supabase por este commit.

## Escopo de segurança

- Projeto permitido: \`bvavzgmsiflydrlgeiqf\`.
- Frontend permitido: \`https://dbertolani.github.io/interpretepro-supabase-teste/\`.
- \`script.js\` mantém \`PAGAMENTOS_SUPABASE_HABILITADOS = false\` até a implantação e configuração das funções.
- Não existe fallback para o Google Apps Script nas ações de pagamento.
- As funções recusam tokens do Mercado Pago que não comecem com \`TEST-\`.
- Não executar cobranças reais nem configurar credenciais de produção.
- A função \`aplicar_pagamento\` deve continuar acessível somente ao \`service_role\`.

## Secrets necessários

Configurar no projeto de homologação, sem colocá-los no GitHub:

- \`MP_ACCESS_TOKEN\`: credencial TEST do Mercado Pago.
- \`MP_WEBHOOK_SECRET\`: segredo de assinatura do webhook da aplicação de teste.
- \`MP_TEST_PAYER_EMAIL\`: e-mail de um usuário de teste do Mercado Pago.
- \`MP_NOTIFICATION_URL\`: exatamente \`https://bvavzgmsiflydrlgeiqf.supabase.co/functions/v1/webhook-mercadopago\`.

O Supabase fornece variáveis do projeto para as funções. O código também espera \`SUPABASE_SERVICE_ROLE_KEY\` no ambiente do servidor e uma chave pública/anon para validar sessões. Nunca incluir a service role no frontend.

## Ordem de implantação

1. Revisar a assinatura e o comportamento da função SQL \`public.aplicar_pagamento\`.
2. Configurar os Secrets de TEST no projeto correto.
3. Implantar as três funções no projeto de homologação.
4. Testar autenticação inválida, plano inexistente/inativo, repetição da mesma chave, falhas de rede, webhook com assinatura inválida e webhook repetido.
5. Confirmar que nenhum teste alterou licenças reais nem criou cobrança real.
6. Somente depois de comprovar o funcionamento, alterar \`PAGAMENTOS_SUPABASE_HABILITADOS\` para \`true\` em \`script.js\`.

## Notas sobre idempotência

- A ordem é criada antes de chamar o Mercado Pago.
- O Pix usa o ID da ordem como chave estável de idempotência no Mercado Pago.
- A assinatura usa uma reivindicação condicional da ordem para evitar duas criações concorrentes. Se a resposta do provedor ficar ambígua, a ordem permanece aguardando reconciliação em vez de criar outra assinatura às cegas.
- As funções de criação não pré-inserem pagamentos pendentes em \`pagamentos_mp\`. A RPC atual \`aplicar_pagamento\` registra a cobrança aprovada dentro da transação; pré-inserir uma linha pendente faria a versão atual da RPC tratá-la como conflito não processado.
- O webhook só chama a RPC após verificar a assinatura do evento, consultar o pagamento no Mercado Pago e comparar referência, valor, moeda e modalidade.
- Eventos de cancelamento de assinatura não revogam automaticamente o período já pago. O estado comercial de cancelamento precisa de uma regra própria antes de ser implementado.

## Deploy manual (não executado)

Na pasta do repositório, com o Supabase CLI autenticado e vinculado ao projeto de homologação:

\`\`\`bash
supabase functions deploy criar-pix --project-ref bvavzgmsiflydrlgeiqf
supabase functions deploy criar-assinatura --project-ref bvavzgmsiflydrlgeiqf
supabase functions deploy webhook-mercadopago --project-ref bvavzgmsiflydrlgeiqf
\`\`\`

Não executar esses comandos contra produção. O deploy não é realizado por este commit.
