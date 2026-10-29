# Edge Functions isoladas — Mercado Pago de homologação

## Estado desta entrega

- Arquivos novos adicionados à branch `homologacao`.
- Nenhuma Edge Function foi publicada.
- Nenhum segredo foi criado, lido ou alterado.
- Nenhum SQL, tabela ou dado do Supabase foi alterado nesta etapa.
- Os endpoints atuais `criar-pix`, `criar-assinatura` e `webhook-mercadopago` não foram editados.

## Arquivos

- `supabase/functions/_shared/supabase-homologacao.ts`
- `supabase/functions/_shared/orders-homologacao.ts`
- `supabase/functions/_shared/mercadopago-homologacao.ts`
- `supabase/functions/criar-pix-homologacao/index.ts`
- `supabase/functions/criar-assinatura-homologacao/index.ts`
- `supabase/functions/webhook-mercadopago-homologacao/index.ts`

## Pré-requisitos antes de publicar

1. Revisar e testar a compilação Deno/Edge Functions.
2. Adicionar `homologacao` aos Exposed schemas da Data API do Supabase e revisar os privilégios. O cliente usa explicitamente `.schema("homologacao")`; sem a exposição da API, as consultas/RPC podem falhar.
3. Criar, por procedimento aprovado, um cliente fictício em `homologacao.clientes_teste` com o e-mail exato da conta autenticada que será usada nos testes.
4. Cadastrar planos explicitamente aprovados em `homologacao.interpretepro_planos`. O código não cria planos nem define preços.
5. Configurar somente os secrets de homologação, após confirmar manualmente no painel do Mercado Pago que a credencial pertence ao ambiente de teste:
   - `MP_TEST_ACCESS_TOKEN` (o código aceita exclusivamente credencial de teste com prefixo `TEST-`; tokens `APP_USR-` são rejeitados por segurança, pois o prefixo também pode estar associado a credenciais de produção)
   - `MP_TEST_CREDENTIALS_CONFIRMED=true` (segunda barreira explícita; não substitui a verificação manual da origem da credencial)
   - Se a conta disponibilizar apenas uma credencial de teste `APP_USR-`, **não contorne a validação nem publique as funções**. Primeiro será necessário definir e validar outro mecanismo confiável de comprovação do ambiente de teste.
   - `MP_TEST_WEBHOOK_SECRET`
   - `MP_TEST_NOTIFICATION_URL` (URL exata do endpoint `/functions/v1/webhook-mercadopago-homologacao`)
   - `MP_TEST_PAYER_EMAIL` (e-mail de usuário de teste do Mercado Pago)
6. Publicar o webhook sem exigir JWT do Supabase, por exemplo usando o procedimento de deploy aprovado com `--no-verify-jwt`. A autenticação do webhook é feita pela assinatura HMAC do Mercado Pago. Não altere a configuração dos webhooks existentes.
7. Só depois de revisar tudo, testar com recursos e usuários de teste do Mercado Pago; não usar credenciais de produção.

## Limitações conhecidas

- O schema `homologacao` não é uma fronteira de segurança equivalente a um segundo projeto Supabase. O cliente backend usa `service_role`, que ignora RLS; cada endpoint deve manter as consultas qualificadas e validações do servidor.
- O cliente de teste é associado pelo e-mail exato, porque `homologacao.clientes_teste` não possui `auth_user_id`.
- O webhook de homologação trata notificações `order` consultando `GET /v1/orders/{id}` e mantém o fluxo legado de notificações `payment` separado. Antes de aplicar licença, confere o status processado/accredited, referência externa, valor, moeda e modalidade.
- O webhook valida que o ID no corpo corresponde ao ID coberto pela assinatura HMAC. A chave de auditoria inclui a ação para que uma notificação inicial de uma order não suprima a notificação posterior de aprovação.
- O webhook verifica o recurso na API do Mercado Pago antes de chamar `homologacao.aplicar_pagamento_homologacao`. A função SQL mantém a idempotência pelo `mp_payment_id`; o registro em `eventos_webhook` é uma camada adicional de auditoria.
- Nenhum teste de compilação, deploy ou chamada ao Mercado Pago foi executado durante esta entrega.
