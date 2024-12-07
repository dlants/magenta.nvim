import { MessageParam } from '@anthropic-ai/sdk';
import { Neovim, NvimPlugin } from 'neovim';

export interface Part {
  content: string;
  type: 'text' | 'code' | 'error';
  startMark?: number;
  endMark?: number;
}

export interface Message {
  role: 'user' | 'assistant';
  parts: Part[];
  startMark?: number;
  endMark?: number;
}

export class Chat {
  private messages: Message[] = [];
  private currentMessage: Message | null = null;

  constructor(private nvim: Neovim) {}

  addMessage(role: Message['role'], content: string): Message {
    const message: Message = {
      role,
      parts: [{
        content,
        type: 'text'
      }]
    };

    this.messages.push(message);
    return message;
  }

  appendToCurrentMessage(text: string, type: Part['type'] = 'text') {
    if (!this.currentMessage) {
      this.currentMessage = {
        role: 'assistant',
        parts: []
      };
      this.messages.push(this.currentMessage);
    }

    const lastPart = this.currentMessage.parts[this.currentMessage.parts.length - 1];
    if (lastPart && lastPart.type === type) {
      lastPart.content += text;
    } else {
      this.currentMessage.parts.push({
        content: text,
        type
      });
    }
  }

  finishCurrentMessage() {
    this.currentMessage = null;
  }

  getCurrentMessage(): string {
    if (!this.currentMessage) return '';
    return this.currentMessage.parts.map(part => part.content).join('');
  }

  getMessages(): MessageParam[] {
    return this.messages.map(msg => ({
      role: msg.role,
      content: msg.parts.map(part => part.content).join('')
    }));
  }

  clear() {
    this.messages = [];
    this.currentMessage = null;
  }

  render(): string {
    return this.messages.map(msg => {
      const role = msg.role.charAt(0).toUpperCase() + msg.role.slice(1);
      const content = msg.parts.map(part => part.content).join('');
      return `${role}: ${content}`;
    }).join('\n\n');
  }
}
