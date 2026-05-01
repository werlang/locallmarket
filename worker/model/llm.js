import { HttpError } from "../helpers/error.js";

export class LLM {

    constructor({ model, host }) {
        this.model = model || process.env.MODEL_RUNNER_MODEL;
        this.host = host || process.env.MODEL_RUNNER_HOST;
    }

    async streamOutput(input, stream) {
        try {
            const controller = new AbortController();
            const response = await fetch(`${this.host}/engines/llama.cpp/v1/chat/completions`, {
                method: "POST",
                headers: { "content-type": "application/json" },
                body: JSON.stringify({
                    model: this.model,
                    messages: [
                        { role: "system", content: "You are a helpful assistant." },
                        { role: "user", content: input }
                    ],
                    stream: true,
                    stream_options: {
                        include_usage: true
                    },
                }),
                signal: controller.signal
            });
    
            if (!response.ok) {
                throw new HttpError(response.status, `Model call failed with status ${response.status}`);
            }

            return await this.#processStream(response, stream, controller);
        }
        catch (error) {
            console.error("Error calling LLM API:", error);
            throw new HttpError(500, error?.message || "Failed to call LLM API.");
        }
    }

    async #processStream(response, stream, controller) {
        const reader = response.body.getReader();
        const decoder = new TextDecoder("utf-8");
        let buffer = "";
        let usage = null;

        try {
            while (true) {
                const { done, value } = await reader.read();
                if (done) break;

                buffer += decoder.decode(value, { stream: true });
                let lines = buffer.split("\n");

                // Process all complete lines except the last one (which may be incomplete)
                for (let i = 0; i < lines.length - 1; i++) {
                    const line = lines[i].trim();
                    if (line.startsWith("data: ")) {
                        const data = line.substring(6).trim();
                        if (data === "[DONE]") {
                            stream.event('end').send("Stream complete.");
                            return usage;
                        }
                        try {
                            const parsed = JSON.parse(data);
                            if (parsed?.usage && typeof parsed.usage === 'object') {
                                usage = {
                                    prompt_tokens: Number(parsed.usage.prompt_tokens ?? 0),
                                    completion_tokens: Number(parsed.usage.completion_tokens ?? 0),
                                    total_tokens: Number(parsed.usage.total_tokens ?? 0)
                                };
                            }
                            const content = parsed.choices?.[0]?.delta?.content || "";
                            if (content) {
                                stream.event('message').send(content);
                            }
                        } catch (e) {
                            console.error("Failed to parse stream data:", e);
                        }
                    }
                }

                // Keep the last line in the buffer (it may be incomplete)
                buffer = lines[lines.length - 1];
            }
        } catch (error) {
            console.error("Error processing stream:", error);
            controller.abort();
            throw new HttpError(500, "Error processing LLM stream.");
        }

        return usage;

    }
}