FROM node:20-slim

WORKDIR /app

COPY package*.json ./
RUN npm install

COPY . .

# Caso utilize porta customizada
EXPOSE 3000

CMD ["npm", "start"]
