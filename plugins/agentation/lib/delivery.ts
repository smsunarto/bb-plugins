export const annotationDeliveryModes = ["Default", "Queue", "Steer"] as const;

export type AnnotationDeliveryMode = (typeof annotationDeliveryModes)[number];

export function followsBbDeliveryDefault(deliveryMode: string): boolean {
  return deliveryMode.toLowerCase() === "default";
}

export function threadSendMode(
  deliveryMode: string,
  steerActiveThreadOnEnter: boolean,
): "queue-if-active" | "steer-if-active" {
  const normalizedMode = deliveryMode.toLowerCase();
  if (normalizedMode === "steer") return "steer-if-active";
  if (normalizedMode === "queue") return "queue-if-active";
  return steerActiveThreadOnEnter ? "steer-if-active" : "queue-if-active";
}
