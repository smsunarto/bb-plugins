declare module "*.css";
declare module "*.svg?url" {
  const url: string;
  export default url;
}
