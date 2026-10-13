# WhatsApp -> CRM (lead automatico do Vinicius)

Conecta o WhatsApp comum do Vinicius ao CRM, pra toda mensagem nova de um
numero desconhecido virar lead automaticamente, sem o lead precisar
preencher nada.

**Importante antes de comecar:** isso usa uma automacao nao-oficial do
WhatsApp (Evolution API, baseado no protocolo do WhatsApp Web). Existe
risco real do numero do Vinicius ser bloqueado pelo WhatsApp, mesmo usando
só pra ler mensagem (nao pra disparo em massa). Use um numero que, se for
bloqueado, nao trava o WhatsApp principal dele, se possivel.

## Como funciona

```
WhatsApp do Vinicius --(Evolution API, rodando na VM)--> webhook
                                                             |
                                                             v
                                                    relay (este projeto)
                                                             |
                                                             v
                                              Firestore: crm_sjc/{workspace}
                                                             |
                                                             v
                                         CRM (thiagojoc.github.io/crm) ja
                                         mostra o lead sozinho, sem precisar
                                         mudar nada no index.html: ele ja
                                         escuta esse documento em tempo real.
```

O relay so cria o lead se o `waNumber` de quem mandou a mensagem ainda nao
existir entre os contatos daquela conta (evita duplicar se a mesma pessoa
mandar mensagem de novo depois).

## Passo 1: criar a conta do Vinicius no CRM

1. Entre em https://thiagojoc.github.io/crm com seu login.
2. No seletor de conta (canto superior), clique em criar uma conta nova,
   de o nome (ex.: "Vinicius").
3. Depois de criada, troque pra ela e veja o id no final da barra de
   enderecos do navegador, ou abra o DevTools (F12) > aba Console e rode
   `currentUser.activeWorkspace` ("Console" do navegador, nao precisa saber
   programar, so colar e apertar Enter). Guarde esse id, e o
   `CRM_WORKSPACE_ID` do passo 4.
4. Em "Participantes" dessa conta, convide o e-mail do Vinicius como
   admin ou membro, pra ele conseguir ver os leads que chegarem.

## Passo 2: gerar a chave de servico do Firebase

1. Entre em https://console.firebase.google.com, projeto `flowbody-30162`.
2. Configuracoes do projeto (engrenagem) > Contas de servico.
3. "Gerar nova chave privada" > confirma > baixa um arquivo `.json`.
4. Renomeie esse arquivo pra `serviceAccountKey.json`.
   **Guarde esse arquivo com cuidado: quem tiver ele consegue ler e
   escrever em TODOS os dados do Firestore, de todas as contas do CRM, nao
   so a do Vinicius. Nunca suba esse arquivo pro GitHub** (o `.gitignore`
   deste repo ja impede isso por engano).

## Passo 3: criar a VM gratuita na Oracle Cloud

1. Crie uma conta em https://www.oracle.com/cloud/free (pede cartao so
   pra confirmar identidade, nao cobra nada no nivel "Always Free").
2. Criar uma instancia de computacao (Compute > Instances > Create
   Instance), usando uma forma (*shape*) `VM.Standard.E2.1.Micro` (ou
   `A1.Flex` com 1 OCPU/6GB, tambem gratuita), imagem Ubuntu.
3. Baixe a chave SSH que a Oracle oferece no momento da criacao, anote o
   IP publico da VM.
4. Depois que a VM estiver no ar, no painel da Oracle libere as portas
   que vamos usar no "Security List" (ou "Network Security Group") da
   VCN: porta 8080 (Evolution API) liberada pra internet. A porta do
   relay (3000) **nao precisa** ser liberada, ela so conversa com o
   Evolution API dentro da propria VM.

## Passo 4: instalar e configurar

Conecte na VM por SSH e rode:

```bash
curl -fsSL https://get.docker.com | sudo sh
sudo usermod -aG docker $USER
# saia e entre de novo no SSH pra o grupo docker valer
git clone https://github.com/thiagojoc/crm.git
cd crm/whatsapp-bridge
cp .env.example .env
nano .env   # preencha WEBHOOK_SECRET e CRM_WORKSPACE_ID (passo 1)
```

Suba o arquivo `serviceAccountKey.json` do passo 2 pra dentro dessa mesma
pasta (`crm/whatsapp-bridge/serviceAccountKey.json`), por `scp` do seu
computador ou copiando o conteudo com `nano serviceAccountKey.json`.

Depois:

```bash
docker compose up -d --build
docker compose logs -f relay   # confirma que subiu sem erro, Ctrl+C pra sair
```

## Passo 5: conectar o WhatsApp do Vinicius

A API pra criar instancia e pegar o QR code muda um pouco entre versoes do
Evolution API; confira a documentacao oficial (https://doc.evolution-api.com)
pra os comandos exatos da versao baixada. Em linhas gerais:

1. Chame a API do Evolution (`http://<ip-da-vm>:8080`) pra criar uma
   instancia nova, usando a `AUTHENTICATION_API_KEY` que voce definiu no
   `docker-compose.yml`.
2. Configure o webhook dessa instancia pra apontar pra
   `http://relay:3000/webhook/<WEBHOOK_SECRET>` (o mesmo texto que voce
   colocou no `.env`), ativado pro evento de mensagem recebida
   (`MESSAGES_UPSERT` ou equivalente).
3. Peca o QR code da instancia (a API devolve uma imagem ou um texto pra
   gerar o QR). Abra o WhatsApp do Vinicius > Aparelhos conectados >
   Conectar um aparelho, e escaneie.
4. Pronto, a partir dai toda mensagem nova de um numero desconhecido vira
   lead na conta configurada.

## Passo 6: testar

Mande uma mensagem de outro celular pro numero do Vinicius (um numero que
ainda nao esteja cadastrado no CRM) e confira se o lead apareceu sozinho
na conta dele, com a tag `lead-whatsapp`.

Se nao aparecer, confira:
- `docker compose logs -f relay` na VM, por erro.
- Se o `CRM_WORKSPACE_ID` no `.env` bate com o id real da conta (passo 1).
- Se o webhook do Evolution API esta mesmo configurado pra essa URL.

## Seguranca e manutencao

- O `WEBHOOK_SECRET` e a unica trava desse endpoint: guarde com cuidado
  e nao poste em nenhum lugar publico (grupo, chat, etc.).
- De tempos em tempos o WhatsApp pode derrubar a sessao conectada (isso e
  normal com esse tipo de ferramenta, nao e so nesse projeto); quando
  isso acontecer, repita o passo 5 pra reconectar.
- Use esse numero so pra receber e criar o lead. Nao usar a mesma conexao
  pra mandar mensagem em massa depois: isso e o que mais aumenta o risco
  de bloqueio do numero.
