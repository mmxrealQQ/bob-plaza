/**
 * FastNet — Lightweight Neural Network for BOB Plaza Agents
 *
 * Pure TypeScript, zero dependencies, no API keys.
 * Each agent gets its own FastNet brain that learns from outcomes.
 *
 * Architecture: Simple feedforward with backpropagation.
 * Activation: ReLU (hidden), Sigmoid (output).
 * Optimizer: SGD with momentum.
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync } from "fs";

// ─── Activation Functions ────────────────────────────────────────────────────

function relu(x: number): number { return x > 0 ? x : 0; }
function reluDeriv(x: number): number { return x > 0 ? 1 : 0; }
function sigmoid(x: number): number { return 1 / (1 + Math.exp(-Math.max(-500, Math.min(500, x)))); }
function sigmoidDeriv(x: number): number { const s = sigmoid(x); return s * (1 - s); }

// ─── Xavier Initialization ──────────────────────────────────────────────────

function xavierInit(fanIn: number, fanOut: number): number {
  const limit = Math.sqrt(6 / (fanIn + fanOut));
  return (Math.random() * 2 - 1) * limit;
}

// ─── FastNet Class ───────────────────────────────────────────────────────────

export interface FastNetConfig {
  layers: number[];         // e.g. [6, 12, 2] = 6 inputs, 12 hidden, 2 outputs
  learningRate?: number;    // default 0.01
  momentum?: number;        // default 0.9
  name?: string;            // agent name for logging
}

export interface FastNetState {
  weights: number[][][];
  biases: number[][];
  velocity_w: number[][][];
  velocity_b: number[][];
  trainCount: number;
  totalLoss: number;
  lastLoss: number;
  createdAt: number;
  lastTrainedAt: number;
}

export class FastNet {
  private layers: number[];
  private weights: number[][][];   // [layer][neuron][weight]
  private biases: number[][];      // [layer][neuron]
  private velocity_w: number[][][];
  private velocity_b: number[][];
  private lr: number;
  private momentum: number;
  private name: string;

  // Stats
  public trainCount = 0;
  public totalLoss = 0;
  public lastLoss = 0;
  private createdAt: number;
  private lastTrainedAt = 0;

  constructor(config: FastNetConfig) {
    this.layers = config.layers;
    this.lr = config.learningRate ?? 0.01;
    this.momentum = config.momentum ?? 0.9;
    this.name = config.name ?? "FastNet";
    this.createdAt = Date.now();

    // Initialize weights and biases
    this.weights = [];
    this.biases = [];
    this.velocity_w = [];
    this.velocity_b = [];

    for (let l = 1; l < this.layers.length; l++) {
      const fanIn = this.layers[l - 1];
      const fanOut = this.layers[l];
      const layerWeights: number[][] = [];
      const layerBiases: number[] = [];
      const layerVW: number[][] = [];
      const layerVB: number[] = [];

      for (let n = 0; n < fanOut; n++) {
        const neuronWeights: number[] = [];
        const neuronVW: number[] = [];
        for (let w = 0; w < fanIn; w++) {
          neuronWeights.push(xavierInit(fanIn, fanOut));
          neuronVW.push(0);
        }
        layerWeights.push(neuronWeights);
        layerBiases.push(0);
        layerVW.push(neuronVW);
        layerVB.push(0);
      }

      this.weights.push(layerWeights);
      this.biases.push(layerBiases);
      this.velocity_w.push(layerVW);
      this.velocity_b.push(layerVB);
    }
  }

  // ─── Forward Pass ──────────────────────────────────────────────────────────

  forward(input: number[]): number[] {
    if (input.length !== this.layers[0]) {
      throw new Error(`Expected ${this.layers[0]} inputs, got ${input.length}`);
    }

    let activations = [...input];

    for (let l = 0; l < this.weights.length; l++) {
      const isOutput = l === this.weights.length - 1;
      const newActivations: number[] = [];

      for (let n = 0; n < this.weights[l].length; n++) {
        let sum = this.biases[l][n];
        for (let w = 0; w < this.weights[l][n].length; w++) {
          sum += activations[w] * this.weights[l][n][w];
        }
        // ReLU for hidden layers, Sigmoid for output
        newActivations.push(isOutput ? sigmoid(sum) : relu(sum));
      }

      activations = newActivations;
    }

    return activations;
  }

  // ─── Train (Backpropagation with SGD + Momentum) ───────────────────────────

  train(input: number[], target: number[]): number {
    if (target.length !== this.layers[this.layers.length - 1]) {
      throw new Error(`Expected ${this.layers[this.layers.length - 1]} targets, got ${target.length}`);
    }

    // Forward pass — store all pre-activations and activations
    const preActivations: number[][] = [];
    const activations: number[][] = [input];
    let current = [...input];

    for (let l = 0; l < this.weights.length; l++) {
      const isOutput = l === this.weights.length - 1;
      const pre: number[] = [];
      const act: number[] = [];

      for (let n = 0; n < this.weights[l].length; n++) {
        let sum = this.biases[l][n];
        for (let w = 0; w < this.weights[l][n].length; w++) {
          sum += current[w] * this.weights[l][n][w];
        }
        pre.push(sum);
        act.push(isOutput ? sigmoid(sum) : relu(sum));
      }

      preActivations.push(pre);
      activations.push(act);
      current = act;
    }

    // Compute loss (MSE)
    const output = activations[activations.length - 1];
    let loss = 0;
    for (let i = 0; i < target.length; i++) {
      loss += (output[i] - target[i]) ** 2;
    }
    loss /= target.length;

    // Backward pass
    let deltas: number[] = [];

    // Output layer deltas
    const lastLayer = this.weights.length - 1;
    for (let n = 0; n < this.weights[lastLayer].length; n++) {
      const error = output[n] - target[n];
      deltas.push(error * sigmoidDeriv(preActivations[lastLayer][n]));
    }

    // Update output layer and propagate back
    for (let l = lastLayer; l >= 0; l--) {
      const prevActivations = activations[l];
      const nextDeltas: number[] = l > 0 ? new Array(this.weights[l - 1]?.length ?? this.layers[l]).fill(0) : [];

      for (let n = 0; n < this.weights[l].length; n++) {
        for (let w = 0; w < this.weights[l][n].length; w++) {
          // Compute gradient
          const grad = deltas[n] * prevActivations[w];

          // Momentum update
          this.velocity_w[l][n][w] = this.momentum * this.velocity_w[l][n][w] - this.lr * grad;
          this.weights[l][n][w] += this.velocity_w[l][n][w];

          // Propagate delta to previous layer
          if (l > 0) {
            nextDeltas[w] += deltas[n] * this.weights[l][n][w];
          }
        }

        // Update bias
        this.velocity_b[l][n] = this.momentum * this.velocity_b[l][n] - this.lr * deltas[n];
        this.biases[l][n] += this.velocity_b[l][n];
      }

      // Apply activation derivative for hidden layers
      if (l > 0) {
        deltas = nextDeltas.map((d, i) => d * reluDeriv(preActivations[l - 1][i]));
      }
    }

    this.trainCount++;
    this.totalLoss += loss;
    this.lastLoss = loss;
    this.lastTrainedAt = Date.now();

    return loss;
  }

  // ─── Predict with confidence ───────────────────────────────────────────────

  predict(input: number[]): { output: number[]; confidence: number } {
    const output = this.forward(input);
    // Confidence = how far from 0.5 the outputs are (on average)
    const confidence = output.reduce((sum, v) => sum + Math.abs(v - 0.5) * 2, 0) / output.length;
    return { output, confidence };
  }

  // ─── Batch Train ───────────────────────────────────────────────────────────

  trainBatch(samples: Array<{ input: number[]; target: number[] }>, epochs = 1): number {
    let totalLoss = 0;
    for (let e = 0; e < epochs; e++) {
      // Shuffle
      const shuffled = [...samples].sort(() => Math.random() - 0.5);
      let epochLoss = 0;
      for (const s of shuffled) {
        epochLoss += this.train(s.input, s.target);
      }
      totalLoss = epochLoss / shuffled.length;
    }
    return totalLoss;
  }

  // ─── Save / Load ──────────────────────────────────────────────────────────

  getState(): FastNetState {
    return {
      weights: this.weights,
      biases: this.biases,
      velocity_w: this.velocity_w,
      velocity_b: this.velocity_b,
      trainCount: this.trainCount,
      totalLoss: this.totalLoss,
      lastLoss: this.lastLoss,
      createdAt: this.createdAt,
      lastTrainedAt: this.lastTrainedAt,
    };
  }

  loadState(state: FastNetState): void {
    this.weights = state.weights;
    this.biases = state.biases;
    this.velocity_w = state.velocity_w;
    this.velocity_b = state.velocity_b;
    this.trainCount = state.trainCount;
    this.totalLoss = state.totalLoss;
    this.lastLoss = state.lastLoss;
    this.createdAt = state.createdAt;
    this.lastTrainedAt = state.lastTrainedAt;
  }

  save(filePath: string): void {
    const dir = filePath.substring(0, filePath.lastIndexOf("/"));
    if (dir && !existsSync(dir)) mkdirSync(dir, { recursive: true });
    writeFileSync(filePath, JSON.stringify(this.getState()));
  }

  load(filePath: string): boolean {
    if (!existsSync(filePath)) return false;
    try {
      const state = JSON.parse(readFileSync(filePath, "utf-8"));
      this.loadState(state);
      return true;
    } catch {
      return false;
    }
  }

  // ─── Stats ─────────────────────────────────────────────────────────────────

  getStats(): { name: string; trainCount: number; avgLoss: number; lastLoss: number; layers: number[] } {
    return {
      name: this.name,
      trainCount: this.trainCount,
      avgLoss: this.trainCount > 0 ? this.totalLoss / this.trainCount : 0,
      lastLoss: this.lastLoss,
      layers: this.layers,
    };
  }
}

// ─── Agent-Specific FastNet Factories ─────────────────────────────────────────

/**
 * Beacon FastNet: Predicts which agents are worth contacting.
 * Input [6]: score, hasA2A, hasCard, responds, categoryCode, ageHours
 * Output [2]: [worthContacting, willRespond]
 */
export function createBeaconNet(): FastNet {
  const net = new FastNet({ layers: [6, 12, 2], learningRate: 0.01, name: "Beacon" });
  net.load("data/fastnet-beacon.json");
  return net;
}

/**
 * Scholar FastNet: Predicts answer usefulness.
 * Input [5]: answerLength(norm), agentScore(norm), previousInteractions, categoryMatch, questionLength(norm)
 * Output [1]: [usefulnessScore]
 */
export function createScholarNet(): FastNet {
  const net = new FastNet({ layers: [5, 10, 1], learningRate: 0.01, name: "Scholar" });
  net.load("data/fastnet-scholar.json");
  return net;
}

/**
 * Synapse FastNet: Predicts connection quality between agent pairs.
 * Input [6]: scoreA(norm), scoreB(norm), sameCategory, categoriesCompatible, responsesA, responsesB
 * Output [1]: [connectionQuality]
 */
export function createSynapseNet(): FastNet {
  const net = new FastNet({ layers: [6, 10, 1], learningRate: 0.01, name: "Synapse" });
  net.load("data/fastnet-synapse.json");
  return net;
}

/**
 * Pulse FastNet: Predicts health and detects anomalies.
 * Input [4]: lastHealthRate(norm), timeSinceCheck(norm), respondingRatio, previousHealth(norm)
 * Output [2]: [predictedHealth, anomalyScore]
 */
export function createPulseNet(): FastNet {
  const net = new FastNet({ layers: [4, 8, 2], learningRate: 0.01, name: "Pulse" });
  net.load("data/fastnet-pulse.json");
  return net;
}

/**
 * Brain FastNet: Meta-learning — which agent action leads to best outcomes.
 * Input [8]: beaconDue, scholarDue, synapseDue, pulseDue, lastSuccess, recentErrorRate, hourOfDay(norm), cyclePhase
 * Output [4]: [beaconPriority, scholarPriority, synapsePriority, pulsePriority]
 */
export function createBrainNet(): FastNet {
  const net = new FastNet({ layers: [8, 16, 4], learningRate: 0.005, name: "Brain" });
  net.load("data/fastnet-brain.json");
  return net;
}

// ─── Normalization Helpers ───────────────────────────────────────────────────

export function normalize(value: number, min: number, max: number): number {
  if (max === min) return 0.5;
  return Math.max(0, Math.min(1, (value - min) / (max - min)));
}

export function encodeCategory(category: string): number {
  const categories: Record<string, number> = {
    defi: 0.1, trading: 0.2, analytics: 0.3, gaming: 0.4,
    social: 0.5, infrastructure: 0.6, security: 0.7, ai: 0.8,
    general: 0.9, unknown: 0.0, spam: 0.0, memetoken: 0.15,
  };
  return categories[category] ?? 0.5;
}
