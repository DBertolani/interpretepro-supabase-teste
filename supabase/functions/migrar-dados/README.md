# Edge Function `migrar-dados`

## Finalidade

Endpoint administrativo usado para receber registros de migração e gravá-los nas tabelas permitidas do Supabase. Esta cópia está versionada para rastreabilidade; criar este arquivo no GitHub não implanta nem altera a função já publicada no Supabase.

## Segurança

- Aceita somente requisições `POST`.
- Valida o cabeçalho `x-migration-secret` contra a variável de ambiente `MIGRATION_SECRET`.
- Usa `SUPABASE_SERVICE_ROLE_KEY` exclusivamente no servidor.
- Nunca colocar valores de segredos neste repositório, no frontend ou em logs.
- Não chamar este endpoint diretamente do navegador.
- A função tem privilégios elevados: mantenha o segredo restrito a processos administrativos confiáveis.

## Variáveis de ambiente necessárias

Configure os valores apenas nos segredos do ambiente de execução da Edge Function:

- `SUPABASE_URL`
- `SUPABASE_SERVICE_ROLE_KEY`
- `MIGRATION_SECRET`

Este documento lista somente os nomes das variáveis; nenhum valor secreto deve ser versionado.

## Tabelas e chaves de conflito permitidas

| Tabela | Coluna(s) de conflito |
| --- | --- |
| `interpretepro_clientes` | `email` |
| `interpretepro_registros_gerais` | `chave_origem` |
| `interpretepro_minhas_empresas` | `chave_origem` |
| `interpretepro_minhas_empresas_finais` | `chave_origem` |
| `interpretepro_tipos_servico` | `chave_origem` |
| `interpretepro_equipe` | `email_usuario,nome_interprete` |

A função rejeita tabelas e colunas de conflito fora desta lista. A opção `ignoreDuplicates: true` solicita que conflitos sejam ignorados, em vez de atualizar o registro existente. A resposta de sucesso não diferencia uma inserção nova de um conflito ignorado.

## Verificação sem gravação

O payload de teste com `tabela: "__teste__"`, enviado com autenticação válida, confirma que a função está acessível e que o segredo foi validado. Esse caminho retorna antes de qualquer operação no banco.

## Implantação

Nenhum deploy é realizado como parte do versionamento. Uma futura implantação deve ser uma ação separada, revisada e autorizada, após confirmar os segredos do ambiente e comparar o código versionado com o código atualmente publicado.
