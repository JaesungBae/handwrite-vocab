import Anthropic from "@anthropic-ai/sdk";
import { NextRequest, NextResponse } from "next/server";

const client = new Anthropic();

export async function POST(req: NextRequest) {
  const { imageBase64, language = "English" } = await req.json();

  const response = await client.messages.create({
    model: "claude-opus-4-6",
    max_tokens: 50,
    messages: [
      {
        role: "user",
        content: [
          {
            type: "image",
            source: { type: "base64", media_type: "image/png", data: imageBase64 },
          },
          {
            type: "text",
            text: `What ${language} word or phrase (1–3 words) is handwritten in this image? Reply with only the word or phrase, nothing else. If unclear, give your best guess.`,
          },
        ],
      },
    ],
  });

  const block = response.content[0];
  const raw = block.type === "text" ? block.text.trim().toLowerCase() : "";
  const word = raw.replace(/[^a-z' -]/g, "").replace(/\s+/g, " ").trim();

  return NextResponse.json({ word });
}
