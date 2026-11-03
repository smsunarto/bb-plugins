import Foundation
import LocalAuthentication
import Security

nonisolated enum VoiceKeychain {
    @concurrent static func authorize() async throws -> String? { try read(allowInteraction: true) }
    private static var query: [String: Any] {
        [kSecClass as String: kSecClassGenericPassword,
         kSecAttrService as String: "app.getbb.clicky-companion.elevenlabs",
         kSecAttrAccount as String: "api-key"]
    }
    static func read(allowInteraction: Bool = false) throws -> String? {
        var lookup = query
        lookup[kSecReturnData as String] = true
        if !allowInteraction {
            let context = LAContext()
            context.interactionNotAllowed = true
            lookup[kSecUseAuthenticationContext as String] = context
        }
        lookup[kSecMatchLimit as String] = kSecMatchLimitOne
        var result: CFTypeRef?
        let status = SecItemCopyMatching(lookup as CFDictionary, &result)
        if status == errSecItemNotFound { return nil }
        guard status == errSecSuccess, let data = result as? Data,
              let key = String(data: data, encoding: .utf8) else { throw KeychainError(status: status) }
        return key
    }
    static func save(_ key: String) throws {
        let value = key.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !value.isEmpty, value.count <= 512, !value.contains(where: { $0.isNewline }) else { throw KeychainError(status: errSecParam) }
        let attributes = [kSecValueData as String: Data(value.utf8)]
        var status = SecItemUpdate(query as CFDictionary, attributes as CFDictionary)
        if status == errSecItemNotFound {
            var item = query
            item.merge(attributes) { _, new in new }
            item[kSecAttrAccessible as String] = kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly
            status = SecItemAdd(item as CFDictionary, nil)
        }
        guard status == errSecSuccess else { throw KeychainError(status: status) }
    }
    static func remove() throws {
        let status = SecItemDelete(query as CFDictionary)
        guard status == errSecSuccess || status == errSecItemNotFound else { throw KeychainError(status: status) }
    }
    struct KeychainError: LocalizedError {
        let status: OSStatus
        var errorDescription: String? {
            if status == errSecInteractionNotAllowed || status == errSecAuthFailed || status == errSecUserCanceled {
                return "macOS Keychain did not authorize this Clicky build. Ask again and approve its Keychain request."
            }
            return "Could not access Clicky’s ElevenLabs key in macOS Keychain (\(status))."
        }
    }
}
