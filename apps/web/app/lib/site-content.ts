import { liveDemoUrl } from "./release-mode";

export interface CatalogExam {
  id: "cissp" | "cism";
  name: string;
  fullName: string;
  summary: string;
  audience: string;
}

export const catalogExams: CatalogExam[] = [
  {
    id: "cissp",
    name: "CISSP",
    fullName: "Certified Information Systems Security Professional",
    summary:
      "A management-level security certification that spans eight domains, from security and risk management through software development security.",
    audience:
      "Suited to experienced security practitioners moving into broader security leadership.",
  },
  {
    id: "cism",
    name: "CISM",
    fullName: "Certified Information Security Manager",
    summary:
      "A management-focused certification built around governance, risk, programme management, and incident management.",
    audience:
      "Suited to security managers and aspiring managers who own policy, risk, and response.",
  },
];

export interface AccessPlan {
  name: string;
  summary: string;
  points: string[];
}

export const accessPlans: AccessPlan[] = [
  {
    name: "Standard",
    summary:
      "Study access for one certification at a time. Buying access for CISSP does not grant CISM.",
    points: [
      "That exam's published questions, answers, and explanations",
      "Practice plus normal timed mock exams",
      "Progress you can return to between sessions",
      "Fixed-term access of 3, 6, or 12 calendar months",
    ],
  },
  {
    name: "Pro",
    summary:
      "Optional adaptive preparation for the exam you are already studying, for exactly three calendar months.",
    points: [
      "Adaptive practice that adjusts difficulty to your answers",
      "Attempt reports on your stronger and weaker areas",
      "Requires Standard access for the same exam for its full three months",
      "Ends without shortening the Standard access you already hold",
    ],
  },
];

export const catalogueFootnote =
  "No all-exam subscription. Each certification is bought and managed separately.";

export const independenceNotice =
  "CISSP and CISM are trademarks of their respective owners. CertPath is independent and is not affiliated with or endorsed by the certification bodies.";

export const availabilityNotice =
  "Practice content for CISSP and CISM is not published yet. Prices, purchasing, and accounts open after content review, so the demo is the best way to see the planned experience today.";

export const demoLink = {
  label: "Try the demo",
  href: liveDemoUrl,
} as const;
