"use client";
import { useEffect } from "react";
import { motion, stagger, useAnimate } from "motion/react";
import { cn } from "@/lib/utils";

// Word-by-word blur-in reveal. Neutralized from the Aceternity default (no font-bold / text-2xl / mt-4
// wrapper) so the caller's className fully controls typography; `wordStagger` + `duration` tune speed.
export const TextGenerateEffect = ({
  words,
  className,
  filter = true,
  duration = 0.5,
  wordStagger = 0.2,
  exit = false,
}: {
  words: string;
  className?: string;
  filter?: boolean;
  duration?: number;
  wordStagger?: number;
  exit?: boolean;
}) => {
  const [scope, animate] = useAnimate();
  const wordsArray = words.split(" ");
  // Generate in on mount; when `exit` flips true, run the same word-by-word blur in reverse (de-generate).
  useEffect(() => {
    animate(
      "span",
      { opacity: exit ? 0 : 1, filter: filter ? (exit ? "blur(10px)" : "blur(0px)") : "none" },
      { duration, delay: stagger(wordStagger) },
    );
  }, [exit]);

  return (
    <div ref={scope} className={className}>
      {wordsArray.map((word, idx) => (
        <motion.span key={word + idx} className="opacity-0" style={{ filter: filter ? "blur(10px)" : "none" }}>
          {word}{" "}
        </motion.span>
      ))}
    </div>
  );
};
