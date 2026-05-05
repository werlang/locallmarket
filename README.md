# LocalLMarket

**🤝 Decentralized LLM compute marketplace. Anyone can contribute GPU power and earn. Anyone can access affordable AI.**

---

## 💡 The Problem

LLM inference is expensive. OpenAI, Claude, Gemini—they all charge premium prices because they own the compute. Meanwhile, millions of people and businesses have idle GPU capacity: a gaming PC, a cloud instance running 4 hours a day, a research lab with spare hardware.

Why should all that compute go unused? Why should consumers pay centralized prices when free-market competition could drive costs down by 10x or 100x?

## 🎯 The Solution

**LocalLMarket** is a decentralized marketplace where:

- **Workers** (anyone with a GPU) register a model, set their own price, and earn credits per completed request.
- **Consumers** find the best-priced worker meeting their needs and call the model via a simple API.
- **The platform** matches orders, streams responses, settles payments, and tracks reputation.

**No gatekeepers. No middlemen. Just fair-market pricing and community compute.**

---

## 🚀 Why LocalLMarket?

| Feature | LocalLMarket | Centralized APIs |
|---------|--------------|-----------------|
| **Pricing** | Free market competition | Fixed, premium rates |
| **Decentralization** | Anyone can contribute compute | Single point of failure |
| **Control** | Run any model, fine-tune yours | Limited model selection |
| **Community** | Join a peer network, earn back | Extract value, no stake |
| **Transparency** | See all pricing, all workers | Black box |

### Honest Limitations

- **Worker honesty**: We can't cryptographically verify workers return correct output (mitigation: reputation scoring, consumer feedback)
- **Reputation system**: Currently simple (24h uptime tracking)
- **UI**: Headless for now; worker dashboard and consumer dashboard to come in future releases

---

## 📊 How It Works

```
┌──────────────┐
│   Consumer   │
│  (Your App)  │
└──────┬───────┘
       │ "I need gpt-3.5 for $0.01/MTks"
       │
       ▼
┌────────────────────────────┐
│   LocalLMarket API Server  │ ◄─── WebSocket ─── Worker 1 (llama-2, $0.005/MTks)
│                            │ ◄─── WebSocket ─── Worker 2 (llama-2, $0.008/MTks)
│  • Order matching          │ ◄─── WebSocket ─── Worker 3 (gpt-3.5 fine-tune, $0.002/MTks)
│  • Price discovery         │
│  • Streaming relay         │
│  • Payment settlement      │
└────────────────────────────┘
       │
       ▼ Stream response (OpenAI format)
┌──────────────┐
│   Response   │ "The answer is..."
│   (SSE)      │
└──────────────┘
```

### How It Works: 3 Personas

#### 1️⃣ **Workers** — Turn Compute into Earnings

**What you do:**
- Register your machine and model on LocalLMarket
- Set your own price (per million tokens)
- Listen for incoming requests
- Run LLM inference on your hardware
- Stream output back to the consumer
- Get credited per completed job

**Getting Started:**
```bash
# Step 1: Create account and get API key from POST /users
# Step 2: Register your model
WORKER_API_KEY=your_key_here WORKER_MODEL=llama-2 WORKER_PRICE=0.005 docker compose -f worker/compose.dev.yaml up -d --build
```

**Pricing Strategy:**
- You set the rate. Lower price → more demand → higher volume.
- Set fair rates → build reputation → consistent long-term earnings.
- Optimize hardware. More efficient = higher margins.

---

#### 2️⃣ **Consumers** — Access Affordable AI

**What you do:**
- Create account and get API key
- Search available workers and models
- Call any model via OpenAI-compatible API
- System automatically picks the best worker (lowest price, meets your constraints)
- Stream response back to your app
- Get billed per million tokens used

**Getting Started:**
```bash
# Step 1: Create account and get API key
curl -X POST http://localhost/users \
  -H "Content-Type: application/json" \
  -d '{"username":"alice","email":"alice@email.com"}'

# Step 2: Check available workers
curl http://localhost/workers/public

# Step 3: Call a model (OpenAI-compatible)
curl http://localhost/v1/chat/completions \
  -H "Authorization: Bearer YOUR_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "model": "llama-2",
    "messages": [{"role": "user", "content": "Hello!"}],
    "stream": true,
  }'
```

**Python Example:**
```python
from openai import OpenAI

client = OpenAI(
    api_key="YOUR_API_KEY",
    base_url="http://localhost"
)

response = client.chat.completions.create(
    model="llama-2",
    messages=[{"role": "user", "content": "Explain p2p markets"}],
    stream=True
)

for chunk in response:
    print(chunk.choices[0].delta.content, end="")
```

---

#### 3️⃣ **Developers** — Build on LocalLMarket

**What to do:**
- Clone the repo and explore the architecture
- Run the stack locally with Docker Compose
- Integrate the OpenAI-compatible API into your app
- Test with real workers
- Deploy to production or self-host

**Getting Started:**
```bash
# Clone and setup
git clone https://github.com/locallmarket/locallmarket.git
cd locallmarket

# Start the API (port 80)
docker compose -f api/compose.yaml up -d --build

# Start a worker (outbound WebSocket to API)
docker compose -f worker/compose.dev.yaml up -d --build

# Test the health endpoint
curl http://localhost/ready

# Run the test suite
npm test

# See full API reference in .github/skills/api-development/SKILL.md
```

---

## 🏗️ Architecture Overview

```
┌─────────────────────────────────────────────────────────────┐
│                    LocalLMarket API Server                  │
│                                                             │
│  ┌────────────────────┐    ┌──────────────────────────┐   │
│  │  HTTP Routes       │    │  Worker WebSocket Server │   │
│  │                    │    │                          │   │
│  │ • POST /users      │    │ • Worker registration   │   │
│  │ • GET /workers/pool│    │ • Job dispatch          │   │
│  │ • POST /v1/chat    │    │ • Stream relay          │   │
│  │ • GET /orders      │    │ • Heartbeat monitoring  │   │
│  │ • GET /ready       │    │                          │   │
│  └────────────────────┘    └──────────────────────────┘   │
│                                                             │
│               ┌──────────────────────────┐                 │
│               │  Order Queue & Matching  │                 │
│               │                          │                 │
│               │ • Price discovery        │                 │
│               │ • Worker selection       │                 │
│               │ • Job state tracking     │                 │
│               └──────────────────────────┘                 │
│                                                             │
│               ┌──────────────────────────┐                 │
│               │    MySQL Database        │                 │
│               │                          │                 │
│               │ • Users & API keys       │                 │
│               │ • Workers & offers       │                 │
│               │ • Orders & billing       │                 │
│               │ • Reputation scores      │                 │
│               └──────────────────────────┘                 │
└─────────────────────────────────────────────────────────────┘
         △                                      △
         │                                      │
    HTTP │ (Consumer)              WebSocket │ (Worker)
         │                                      │
    Consumer App                          Worker Service
```

**Key Design Principles:**

- **API owns the HTTP surface** and worker queue; thin composition root (`api/app.js`)
- **Workers connect outbound** via WebSocket; API doesn't initiate connections
- **Settlement happens per-job**: Consumer credits deducted → Worker credits incremented
- **Reputation updated every 24h**: Uptime tracking, request count, reputation score

---

## 📋 API Reference

### Public Health Check
```
GET /ready
Response: { "ok": true, "connectedWorkers": 5, "availableWorkers": 4, "activeJobs": 2, "queuedJobs": 0 }
```

### User Management
```
POST /users                    # Create account
GET /users                     # Get profile
PUT /users                     # Update profile settings (max_price, min_tps)
POST /users/recharge           # Recharge account credits
POST /users/reset              # Reset account API Key
```

### Worker Pool & Management
```
GET /workers                   # See all my registered workers (requires auth)
GET /workers/public            # See all public workers available for matching
POST /workers                  # Register a worker
```

### Orders & Billing
```
GET /orders                    # Your order history
POST /v1/chat/completions      # Call a model (OpenAI-compatible)
POST /v1/responses             # Call a model with OpenAI Responses API
```

**For full details, see** [.github/skills/api-development/SKILL.md](.github/skills/api-development/SKILL.md)

---

## 🛠️ For Workers: Getting Started

### Requirements
- **Hardware**: GPU (recommended) or multi-core CPU
- **Software**: Python 3.8+, any LLM runtime (vLLM, ollama, llama.cpp)
- **Network**: Stable internet, outbound WebSocket access to API server

### Setup

**Option 1: Docker (Recommended)**
```bash
# Clone repo
git clone https://github.com/locallmarket/locallmarket.git
cd locallmarket/worker

# Build the worker container
docker build -t locallmarket-worker .

# Run with your API key
docker run -e WORKER_API_KEY=your_key_here \
           -e WORKER_MODEL=llama-2 \
           -e WORKER_PRICE=0.005 \
           -e WORKER_TPS=50 \
           locallmarket-worker
```

**Option 2: Local Development**
```bash
cd worker
npm install
WORKER_API_KEY=your_key WORKER_MODEL=llama-2 npm start
```

### Configuration

| Env Var | Example | Purpose |
|---------|---------|---------|
| `WORKER_API_KEY` | `sk_abc123` | Your API key from LocalLMarket |
| `WORKER_MODEL` | `llama-2` | Model name to advertise |
| `WORKER_PRICE` | `0.005` | Price per request (in credits) |
| `WORKER_TPS` | `50` | Throughput (requests per second) |
| `API_ENDPOINT` | `http://api.locallmarket.com` | API server URL |

### Monitoring Your Earnings
```bash
# Check your worker status
curl http://api.locallmarket.com/workers \
  -H "Authorization: Bearer YOUR_API_KEY"

# Response includes: activeJobs, completedJobs, totalEarnings, uptime%, reputation
```

### Pricing Strategy Tips
- **Undercut competitors**: If others charge $0.01, try $0.008 → more demand
- **Build reputation**: Consistent, fair pricing → long-term trust → stable volume
- **Monitor peers**: Use `/workers/public` to see competitor pricing in real-time
- **Optimize hardware**: Faster execution = higher TPS = more requests/earnings

---

## 💳 For Consumers: Getting Started

### Requirements
- **Account**: Free signup with email (You get an API key)
- **Network**: HTTPS access to API endpoint
- **Integration**: Your app (Python, Node.js, curl, anything)

### Setup

**Step 1: Create Account**
```bash
curl -X POST http://localhost/users \
  -H "Content-Type: application/json" \
  -d '{
    "name": "User",
    "email": "user@example.com",
  }'
# Returns: { "ok": true, "apiKey": "..." }
```

**Step 2: Add Credits**
```bash
curl -X POST http://localhost/users/recharge \
  -H "Authorization: Bearer YOUR_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{ "amount": 100 }'  # 100 credits
```

**Step 3: Explore Workers**
```bash
curl http://localhost/workers/public \
```

**Step 4: Call a Model**
```bash
curl -X POST http://localhost/v1/chat/completions \
  -H "Authorization: Bearer YOUR_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "model": "llama-2",
    "messages": [
      { "role": "system", "content": "You are helpful." },
      { "role": "user", "content": "What is 2+2?" }
    ],
    "stream": true,
    "temperature": 0.7,
    "max_tokens": 100
  }'
```

### Constraints (Optional)
Update your user preferences to control cost and performance:
```json
{
  "max_price": 0.01,           // Don't use workers charging > $0.01/req
  "min_tps": 50,               // Don't use workers with < 50 req/sec throughput
}
```

### Node.js Example
```javascript
const OpenAI = require('openai');

const client = new OpenAI({
  apiKey: process.env.LOCALLMARKET_API_KEY,
  baseURL: 'http://localhost'
});

async function chat() {
  const stream = await client.chat.completions.create({
    model: 'llama-2',
    messages: [{ role: 'user', content: 'Hello!' }],
    stream: true
  });

  for await (const chunk of stream) {
    process.stdout.write(chunk.choices[0]?.delta?.content || '');
  }
}

chat();
```

---

## Known Limitations & Roadmap

**Can we verify workers are honest?**
- ⚠️ **Today**: No cryptographic proof. We rely on reputation and consumer feedback.
- **Future**: 
  - Dispute resolution system for consumer complaints

---

## 🐛 Contributing

Found a bug? Have a feature idea? Want to run a worker? We'd love your help!

### For Bug Reports & Features
1. Open an issue on [GitHub](https://github.com/locallmarket/locallmarket/issues)
2. Follow the template and provide reproduction steps
3. Describe what you expected vs. what happened

### For Code Contributions
1. Read [.github/instructions.md](.github/instructions.md)
2. Fork the repo, create a branch, make your changes
3. Add tests and run the test suite (`npm test`)
4. Submit a pull request with a clear description
5. Our team will review and merge

### For Workers
- Join the network and contribute GPU power
- Set competitive pricing
- Help other workers and consumers on community forums
- Share feedback on how we can improve

### Testing Locally
```bash
# Install dependencies
npm install

# Run unit and integration tests
npm test

# Run tests with coverage
npm test -- --coverage

# Lint
npm run lint
```

---

## 📚 More Resources

- **API Development**: [.github/skills/api-development/SKILL.md](.github/skills/api-development/SKILL.md)
- **Testing Guide**: [.github/skills/api-testing/SKILL.md](.github/skills/api-testing/SKILL.md)
- **Docker Setup**: [.github/skills/docker-deployment/SKILL.md](.github/skills/docker-deployment/SKILL.md)
- **Bug Review**: [.github/skills/backend-bug-review/SKILL.md](.github/skills/backend-bug-review/SKILL.md)

---

## 📜 License

LocalLMarket is released under the **MIT License**. See [LICENSE](LICENSE) for details.

### Community

- **GitHub Issues**: [Report bugs or request features](https://github.com/locallmarket/locallmarket/issues)
- **Discussions**: [Community chat and ideas](https://github.com/locallmarket/locallmarket/discussions)
- **Email**: [support@locallmarket.com](mailto:support@locallmarket.com)

---

**Ready to join the decentralized compute marketplace? Start as a worker, consumer, or developer.** 🚀

