import type { FastifyCorsOptions } from "@fastify/cors";

export const corsOrigin = "https://term-forge-msd12xv40-sactum.vercel.app";

export const corsOptions: FastifyCorsOptions = {
  origin: [corsOrigin],
  credentials: true,
};
